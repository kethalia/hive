import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindMany = vi.hoisted(() => vi.fn());
const mockUpsert = vi.hoisted(() => vi.fn());
const mockDeleteMany = vi.hoisted(() => vi.fn());
const mockGetSession = vi.hoisted(() => vi.fn());
const mockCookieStore = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(() => mockCookieStore),
}));

vi.mock("@hive/db", () => ({
  getDb: () => ({
    navigationFavorite: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      upsert: (...args: unknown[]) => mockUpsert(...args),
      deleteMany: (...args: unknown[]) => mockDeleteMany(...args),
    },
  }),
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

import {
  listNavigationFavoritesAction,
  removeNavigationFavoriteAction,
  upsertNavigationFavoriteAction,
} from "@/lib/actions/navigation-favorites";

const validSession = {
  user: {
    id: "user-123",
    coderUrl: "https://coder.example.com",
    coderUserId: "cu1",
    username: "testuser",
    email: "test@example.com",
  },
  session: {
    id: "sid1",
    sessionId: "sess-123",
    expiresAt: new Date(Date.now() + 86_400_000),
  },
};

const favoriteRow = {
  id: "fav-1",
  userId: "user-123",
  kind: "git",
  workspaceId: "workspace-1",
  targetKey: "git-clone:kethalia/hive",
  label: "Hive",
  relativePath: "kethalia/hive",
  createdAt: new Date("2026-06-02T00:00:00.000Z"),
};

describe("navigation favorites actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockGetSession.mockResolvedValue(validSession);
    mockFindMany.mockResolvedValue([favoriteRow]);
    mockUpsert.mockResolvedValue(favoriteRow);
    mockDeleteMany.mockResolvedValue({ count: 1 });
  });

  it("lists authenticated favorites scoped by user and workspace", async () => {
    const result = await listNavigationFavoritesAction({ workspaceId: "workspace-1" });

    expect(result?.serverError).toBeUndefined();
    expect(result?.data).toEqual([
      {
        id: "fav-1",
        kind: "git",
        workspaceId: "workspace-1",
        targetKey: "git-clone:kethalia/hive",
        label: "Hive",
        relativePath: "kethalia/hive",
        createdAt: "2026-06-02T00:00:00.000Z",
      },
    ]);
    expect(mockFindMany).toHaveBeenCalledWith({
      where: {
        userId: "user-123",
        workspaceId: "workspace-1",
      },
      orderBy: [{ kind: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
  });

  it("filters list queries by kind without dropping user scoping", async () => {
    await listNavigationFavoritesAction({ workspaceId: "workspace-1", kind: "terminal" });

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: "user-123",
          workspaceId: "workspace-1",
          kind: "terminal",
        },
      }),
    );
  });

  it("upserts terminal favorites with the composite user-owned idempotency predicate", async () => {
    const row = {
      ...favoriteRow,
      kind: "terminal",
      targetKey: "main.shell",
      label: "Main shell",
      relativePath: null,
    };
    mockUpsert.mockResolvedValue(row);

    const result = await upsertNavigationFavoriteAction({
      kind: "terminal",
      workspaceId: "workspace-1",
      targetKey: "main.shell",
      label: " Main shell ",
    });

    expect(result?.serverError).toBeUndefined();
    expect(result?.data).toMatchObject({
      kind: "terminal",
      targetKey: "main.shell",
      label: "Main shell",
      relativePath: null,
    });
    expect(mockUpsert).toHaveBeenCalledWith({
      where: {
        userId_kind_workspaceId_targetKey: {
          userId: "user-123",
          kind: "terminal",
          workspaceId: "workspace-1",
          targetKey: "main.shell",
        },
      },
      update: {
        label: "Main shell",
        relativePath: null,
      },
      create: {
        userId: "user-123",
        kind: "terminal",
        workspaceId: "workspace-1",
        targetKey: "main.shell",
        label: "Main shell",
        relativePath: null,
      },
    });
  });

  it("stores Git favorites only as public clone identifiers and root-relative paths", async () => {
    const result = await upsertNavigationFavoriteAction({
      kind: "git",
      workspaceId: "workspace-1",
      targetKey: "git-clone:kethalia/hive",
      relativePath: "kethalia/hive",
      label: "Hive",
    });

    expect(result?.serverError).toBeUndefined();
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_kind_workspaceId_targetKey: {
            userId: "user-123",
            kind: "git",
            workspaceId: "workspace-1",
            targetKey: "git-clone:kethalia/hive",
          },
        },
        create: expect.objectContaining({
          targetKey: "git-clone:kethalia/hive",
          relativePath: "kethalia/hive",
        }),
      }),
    );
  });

  it("removes favorites with deleteMany scoped to the authenticated user", async () => {
    const result = await removeNavigationFavoriteAction({
      kind: "git",
      workspaceId: "workspace-1",
      targetKey: "git-clone:kethalia/hive",
    });

    expect(result?.data).toEqual({ success: true });
    expect(mockDeleteMany).toHaveBeenCalledWith({
      where: {
        userId: "user-123",
        kind: "git",
        workspaceId: "workspace-1",
        targetKey: "git-clone:kethalia/hive",
      },
    });
  });

  it("does not cross user boundaries when another authenticated user mutates the same target", async () => {
    mockGetSession.mockResolvedValueOnce({
      ...validSession,
      user: { ...validSession.user, id: "user-456" },
    });

    await upsertNavigationFavoriteAction({
      kind: "git",
      workspaceId: "workspace-1",
      targetKey: "git-clone:kethalia/hive",
      relativePath: "kethalia/hive",
      label: "Hive",
    });

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_kind_workspaceId_targetKey: {
            userId: "user-456",
            kind: "git",
            workspaceId: "workspace-1",
            targetKey: "git-clone:kethalia/hive",
          },
        },
        create: expect.objectContaining({ userId: "user-456" }),
      }),
    );
  });

  it("trims and bounds display labels without treating them as authority", async () => {
    const longLabel = `  ${"Favorite ".repeat(30)}  `;
    const expectedLabel = longLabel.trim().slice(0, 120);
    mockUpsert.mockResolvedValue({ ...favoriteRow, label: expectedLabel });

    const result = await upsertNavigationFavoriteAction({
      kind: "git",
      workspaceId: "workspace-1",
      targetKey: "git-clone:kethalia/hive",
      relativePath: "kethalia/hive",
      label: longLabel,
    });

    expect(result?.serverError).toBeUndefined();
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ label: expectedLabel }),
        create: expect.objectContaining({ label: expectedLabel }),
      }),
    );
  });

  it("rejects reserved clone terminal session names before DB writes", async () => {
    const result = await upsertNavigationFavoriteAction({
      kind: "terminal",
      workspaceId: "workspace-1",
      targetKey: "git-clone-safe-hive",
      label: "Clone terminal",
    });

    expect(result?.validationErrors).toBeDefined();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("rejects malformed Git favorite keys and paths before DB writes", async () => {
    const badInputs = [
      {
        kind: "git" as const,
        workspaceId: "workspace-1",
        targetKey: "kethalia/hive",
        relativePath: "kethalia/hive",
      },
      {
        kind: "git" as const,
        workspaceId: "workspace-1",
        targetKey: "git-clone:/abs/hive",
        relativePath: "/abs/hive",
      },
      {
        kind: "git" as const,
        workspaceId: "workspace-1",
        targetKey: "git-clone:kethalia/../hive",
        relativePath: "kethalia/../hive",
      },
      {
        kind: "git" as const,
        workspaceId: "workspace-1",
        targetKey: "git-clone:kethalia\\hive",
        relativePath: "kethalia\\hive",
      },
      {
        kind: "git" as const,
        workspaceId: "workspace-1",
        targetKey: "git-clone:kethalia\0hive",
        relativePath: "kethalia\0hive",
      },
    ];

    for (const input of badInputs) {
      const result = await upsertNavigationFavoriteAction(input);
      expect(result?.validationErrors).toBeDefined();
    }
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("rejects unsafe labels that look like private paths, terminal URLs, clone proofs, or terminal contents", async () => {
    for (const label of [
      "/home/coder/secret/repo",
      "wss://terminal.example/socket",
      "cloneProof=secret-token",
      "first line\nsecond line",
      "bad\0label",
    ]) {
      const result = await upsertNavigationFavoriteAction({
        kind: "git",
        workspaceId: "workspace-1",
        targetKey: "git-clone:kethalia/hive",
        relativePath: "kethalia/hive",
        label,
      });
      expect(result?.validationErrors).toBeDefined();
    }
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated calls before DB reads or writes", async () => {
    mockGetSession.mockResolvedValue(null);

    const result = await listNavigationFavoritesAction({ workspaceId: "workspace-1" });

    expect(result?.serverError).toBe("Not authenticated");
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it("returns sanitized unavailable errors for malformed DB rows", async () => {
    mockFindMany.mockResolvedValue([{ ...favoriteRow, createdAt: "not-a-date" }]);

    const result = await listNavigationFavoritesAction({ workspaceId: "workspace-1" });

    expect(result?.serverError).toBe("Favorites are unavailable. Refresh and try again.");
    expect(JSON.stringify(result)).not.toContain("not-a-date");
  });
});
