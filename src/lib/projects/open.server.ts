import { getDb } from "@hive/db";
import { DeliveryRepository } from "@/lib/delivery/repository";
import { DeliveryConflict } from "@/lib/delivery/state";
import { ProjectDiscoveryError } from "./errors";
import { type ProjectPrincipal, signedHostProjectRequest } from "./host.server";
import {
  enrolledProjectSchema,
  type OpenedProject,
  projectOpenRequestSchema,
  resolvedRepositorySchema,
} from "./session-contracts";
import { resolveProjectSourceBase } from "./source-base.server";
import { pendingTaskStatus } from "./task-intents.server";

/** Repository identity and authorization come from the fixed authenticated helper,
 * never a browser-supplied name, clone URL, local path or cached discovery page. */
export async function openProject(user: ProjectPrincipal, value: unknown) {
  const input = projectOpenRequestSchema.parse(value);
  const target = { repositoryId: input.repositoryId, expectedAccountId: input.providerAccountId };
  const resolved = resolvedRepositorySchema.safeParse(
    await signedHostProjectRequest(user, input.workspaceId, "/projects/resolve", {
      schemaVersion: 1,
      ...target,
    }),
  );
  if (
    !resolved.success ||
    resolved.data.providerAccountId !== input.providerAccountId ||
    resolved.data.repository.providerRepositoryId !== input.repositoryId
  )
    throw new ProjectDiscoveryError("github_invalid_response");
  if (resolved.data.repository.permissions.pull !== true)
    throw new ProjectDiscoveryError("github_permission_denied");
  const project = await new DeliveryRepository(getDb()).bindProject(user.id, {
    provider: "github",
    providerRepositoryId: input.repositoryId,
    providerAccountId: resolved.data.providerAccountId,
    fullName: resolved.data.repository.fullName,
  });
  const opened = enrolledProjectSchema.safeParse(
    await signedHostProjectRequest(user, input.workspaceId, "/projects/open", {
      schemaVersion: 1,
      ...target,
      projectId: project.id,
      requestId: input.requestId,
    }),
  );
  if (
    !opened.success ||
    opened.data.projectId !== project.id ||
    opened.data.providerAccountId !== input.providerAccountId ||
    opened.data.repository.providerRepositoryId !== input.repositoryId
  )
    throw new ProjectDiscoveryError("github_invalid_response");
  if (opened.data.repository.permissions.pull !== true)
    throw new ProjectDiscoveryError("github_permission_denied");
  // Resolve and enrollment independently validate access. Names may change between
  // them; record only the most recently verified name, preserving the stable ID.
  if (opened.data.repository.fullName !== project.fullName)
    await new DeliveryRepository(getDb()).bindProject(user.id, {
      provider: "github",
      providerRepositoryId: input.repositoryId,
      providerAccountId: input.providerAccountId,
      fullName: opened.data.repository.fullName,
    });
  let current: Omit<OpenedProject, "workspaceId"> = opened.data;
  if (
    current.phase === "awaitingTask" &&
    !current.currentTaskId &&
    !current.nativeThreadId &&
    !current.terminalSessionName
  ) {
    // The durable request precedes host admission. Reopening reads that request's
    // status without starting/retrying it or replacing a task owned by the host.
    const intent = await getDb().projectTaskIntent.findFirst({
      where: {
        ownerId: user.id,
        projectId: project.id,
        workspaceId: input.workspaceId,
        repositoryId: input.repositoryId,
        providerAccountId: input.providerAccountId,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        ownerId: true,
        projectId: true,
        workspaceId: true,
        repositoryId: true,
        providerAccountId: true,
        phase: true,
        status: true,
        guardianAdmissions: {
          where: { runtime: { phase: { in: ["barrier_closed", "tree_closed"] } } },
          select: { id: true },
          take: 1,
        },
      },
    });
    if (intent) {
      if (
        intent.ownerId !== user.id ||
        intent.projectId !== project.id ||
        intent.workspaceId !== input.workspaceId ||
        intent.repositoryId !== input.repositoryId ||
        intent.providerAccountId !== input.providerAccountId
      )
        throw new ProjectDiscoveryError("github_invalid_response");
      // Check eligibility only after selecting the latest accepted request.
      // Completed work must not uncover older blocked/pending task history.
      if (
        ["queued", "preparing", "blocked"].includes(intent.phase) &&
        intent.guardianAdmissions.length === 0
      ) {
        const saved = pendingTaskStatus(intent);
        if (
          saved.projectId !== project.id ||
          saved.taskId !== intent.id ||
          ["running", "awaitingTask"].includes(saved.phase) ||
          (intent.phase === "blocked") !== (saved.phase === "blocked")
        )
          throw new ProjectDiscoveryError("github_invalid_response");
        current = {
          ...current,
          phase: saved.phase,
          currentTaskId: saved.taskId,
          nativeThreadId: saved.nativeThreadId,
          terminalSessionName: saved.terminalSessionName,
          currentTaskStatus: saved,
        };
      }
    }
  }
  // Existing conversations remain readable while delivery policy/ref resolution
  // needs attention. A new task still reauthorizes its source independently.
  try {
    const sourceBase = await resolveProjectSourceBase(user, input.workspaceId, opened.data);
    return { ...current, workspaceId: input.workspaceId, sourceBase };
  } catch (error) {
    if (!(error instanceof DeliveryConflict) && !(error instanceof ProjectDiscoveryError))
      throw error;
    return { ...current, workspaceId: input.workspaceId, sourceBaseUnavailable: true };
  }
}
