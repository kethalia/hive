import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PrismaClient } from "@hive/db";
import { afterAll, describe, expect, it } from "vitest";
import {
  expectedGuardianHostConfig,
  guardianConfigSha256,
} from "@/lib/codex-session/guardian-config.server";
import {
  GUARDIAN_METADATA_POLICY_DIGEST,
  type GuardianPolicy,
} from "@/lib/codex-session/guardian-contracts";
import { GuardianService } from "@/lib/codex-session/guardian-service.server";
import { ProjectTaskIntents } from "@/lib/projects/task-intents.server";
import { buildNativeGuardian } from "../../../../scripts/build-native-guardian.mjs";
import {
  GUARDIAN_CONTROLLER_POLICY_DIGEST,
  openGuardianController,
} from "../../../../templates/ai-dev-k8s/scripts/codex-guardian-controller.mjs";
import { openGuardedHost } from "../../../../templates/ai-dev-k8s/scripts/codex-host-guardian.mjs";

const url = process.env.HIVE_DELIVERY_TEST_DATABASE_URL;
if (
  url &&
  (!["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
    new URL(url).pathname !== "/hive_delivery_test")
)
  throw new Error("Isolated fixture only");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_delivery_test",
});
afterAll(() => db.$disconnect());
const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const hash = (path: string) => sha(readFileSync(path));
async function freePort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture port rejected");
  const port = address.port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

describe.skipIf(!url)(
  "real guardian outer/FD3/owner-app/signed controller/PostgreSQL composition",
  () => {
    it("enrolls before preparation, gates actual Git, seals checkout inode and reserves exactly one native launch", async () => {
      const pinnedNode = process.env.HIVE_GUARDIAN_INSTALLED_FIXTURE_NODE;
      if (!pinnedNode) {
        // CI caches can have a different UID or group-write bit. Re-exec only
        // this fixture under one owned readonly copy, preserving Node's version
        // and exact outer/worker inode agreement. Product pins stay unchanged.
        const launcher = mkdtempSync(join(tmpdir(), "hive-guardian-installed-node-")),
          executable = join(launcher, "node"),
          log = join(launcher, "result.log");
        copyFileSync(realpathSync(process.execPath), executable);
        chmodSync(executable, 0o500);
        try {
          const output = execFileSync(
            executable,
            [
              realpathSync("node_modules/vitest/vitest.mjs"),
              "run",
              "src/__tests__/lib/codex-session/guardian-installed.integration.test.ts",
              "--reporter=verbose",
            ],
            {
              encoding: "utf8",
              timeout: 45000,
              maxBuffer: 1048576,
              env: { ...process.env, HIVE_GUARDIAN_INSTALLED_FIXTURE_NODE: executable },
            },
          );
          writeFileSync(log, output, { mode: 0o600 });
        } catch (error) {
          const failure = error as { stdout?: string | Buffer; stderr?: string | Buffer };
          writeFileSync(log, `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`, { mode: 0o600 });
          throw new Error(`Pinned fixture subprocess failed; retained ${log}`, { cause: error });
        }
        rmSync(launcher, { recursive: true, force: true });
        return;
      }
      const own = statSync(pinnedNode);
      expect(realpathSync(process.execPath)).toBe(pinnedNode);
      expect(own.uid).toBe(process.getuid?.());
      expect(own.mode & 0o222).toBe(0);
      const directory = mkdtempSync(join(tmpdir(), "hive-guardian-installed-")),
        packageDirectory = join(directory, "package"),
        home = directory;
      let host: Awaited<ReturnType<typeof openGuardedHost>> | undefined,
        cleanupSafe = false,
        primaryError: unknown,
        shutdownError: unknown;
      try {
        const build = buildNativeGuardian(resolve("."), packageDirectory),
          node = realpathSync(process.execPath);
        copyFileSync(
          "templates/ai-dev-k8s/scripts/codex-guardian-worker.mjs",
          join(packageDirectory, "codex-guardian-worker.mjs"),
        );
        const user = await db.user.create({
          data: {
            coderUrl: "https://guardian-installed-coder.invalid",
            coderUserId: randomUUID(),
            username: "guardian-installed-fixture",
            email: "fixture@invalid",
          },
        });
        const project = await db.deliveryProject.create({
          data: {
            ownerId: user.id,
            provider: "github",
            providerRepositoryId: "123",
            providerAccountId: "456",
            fullName: "fixture/repository",
          },
        });
        const issuer = generateKeyPairSync("ed25519"),
          port = await freePort(),
          binding = {
            coderOrigin: user.coderUrl,
            hiveUserId: user.id,
            ownerId: user.coderUserId,
            workspaceId: randomUUID(),
            agentId: randomUUID(),
            buildId: randomUUID(),
            templateId: randomUUID(),
            appOrigin: "https://guardian-installed-app.invalid",
            appId: randomUUID(),
          };
        const sessionConfig = {
          privateKeyPem: issuer.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
          keyId: "guardian-installed-fixture",
          hiveOrigin: "https://guardian-installed-hive.invalid",
          softwareTemplateIds: [binding.templateId],
          appSlug: "codex-session",
          gatewayPort: port,
          cookieDomains: [],
        };
        const env = {
            HIVE_CODEX_MANAGER_MODEL: "gpt-6.1-sol",
            HIVE_CODEX_MANAGER_EFFORT: "low",
            HIVE_DELIVERY_MANAGER_ENABLED: "true",
          },
          config = expectedGuardianHostConfig({ ...binding, projects: [] }, sessionConfig, env),
          configSha256 = guardianConfigSha256(config),
          request = {
            schemaVersion: 1 as const,
            projectId: project.id,
            repositoryId: "123",
            expectedAccountId: "456",
            taskId: randomUUID(),
            requestId: randomUUID(),
            revision: "a".repeat(40),
            model: "gpt-6.1-sol",
            effort: "low",
            text: "Local guardian fixture; never account inference",
          },
          preparation = {
            schemaVersion: 1,
            stage: "preparation",
            ownerId: binding.ownerId,
            workspaceId: binding.workspaceId,
            buildId: binding.buildId,
            projectId: project.id,
            repositoryId: "123",
            providerAccountId: "456",
            taskId: request.taskId,
            requestId: request.requestId,
            baseSha: request.revision,
            requestDigest: sha(JSON.stringify(request)),
          };
        await new ProjectTaskIntents(db, "19".repeat(32)).enqueue({
          ownerId: user.id,
          projectId: project.id,
          workspaceId: binding.workspaceId,
          taskId: request.taskId,
          requestId: request.requestId,
          requestDigest: sha("fixture-owner-request"),
          hostRequest: request,
        });
        const script = `import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {createHmac,createHash,randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {connectGuardianWorker,createGuardianOwnerHandler} from './codex-guardian-worker.mjs';
const guard=await connectGuardianWorker({startup:${JSON.stringify({ configSha256, port })},onCloseAdmission:async()=>{},onLost:()=>process.exitCode=1});
const handler=createGuardianOwnerHandler({appOrigin:${JSON.stringify(binding.appOrigin)},guardian:guard});
const directory=${JSON.stringify(join(home, ".local/state/hive/codex-project-controller"))};mkdirSync(directory,{recursive:true,mode:448});
const prep=${JSON.stringify(preparation)},request=${JSON.stringify(request)},digest=createHash('sha256').update(JSON.stringify(prep)).digest('hex');
const key=Buffer.alloc(32,13);writeFileSync(join(directory,'projects.key'),key,{mode:384});
const identity=()=>{const p='/proc/'+process.pid;const fields=String(execFileSync('/usr/bin/cat',[p+'/stat'])).slice(String(execFileSync('/usr/bin/cat',[p+'/stat'])).lastIndexOf(') ')+2).trim().split(/\\s+/);const s=statSync(p+'/exe',{bigint:true});return {pid:process.pid,startTime:fields[19],bootId:String(execFileSync('/usr/bin/cat',['/proc/sys/kernel/random/boot_id'])).trim(),executable:${JSON.stringify(node)},device:String(s.dev),inode:String(s.ino)}};
let state={schemaVersion:1,ownerId:prep.ownerId,workspaceId:prep.workspaceId,guardianLifetimeId:guard.state.lifetimeId,hostProcess:identity(),projects:{[prep.projectId]:{projectId:prep.projectId,repositoryId:prep.repositoryId,task:{taskId:prep.taskId,phase:'preparing',request,guardianPreparation:prep}}}};
const save=()=>writeFileSync(join(directory,'projects.json'),JSON.stringify({state,signature:createHmac('sha256',key).update(JSON.stringify(state)).digest('hex')}),{mode:384});save();
let token;
const server=createServer((req,res)=>{void(async()=>{
 if(req.url==='/fixture/prepare'&&req.method==='POST'){
 token=await guard.admit({projectId:prep.projectId,bindingDigest:digest});guard.assertAdmission(token);
 const checkout=${JSON.stringify(join(home, "checkout"))};mkdirSync(checkout,{mode:448});
 execFileSync('/usr/bin/git',['init','--quiet',checkout],{env:{PATH:'/usr/bin:/bin'},stdio:'ignore'});
 const info=statSync(checkout,{bigint:true});state.projects[prep.projectId].task.guardianPrepared={schemaVersion:1,preparationDigest:digest,projectId:prep.projectId,repositoryId:prep.repositoryId,taskId:prep.taskId,revision:prep.baseSha,leaseId:randomUUID(),leaseGeneration:1,checkoutIncarnation:randomUUID(),checkoutIdentity:{device:String(info.dev),inode:String(info.ino)}};save();
 token=await guard.executionFence(token);guard.assertAdmission(token);res.writeHead(200);res.end('{}');return;
 }
 if(req.url==='/fixture/launch'&&req.method==='POST'){const result=await guard.metadataAuthority({projects:[{projectId:prep.projectId}]});res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));return;}
 await handler(req,res);
})().catch(()=>{if(!res.headersSent)res.writeHead(403);res.end();});});
await new Promise(r=>server.listen(${port},'127.0.0.1',r));await guard.ready(${JSON.stringify({ configSha256, port })});`;
        writeFileSync(join(packageDirectory, "fixture-worker.mjs"), script, { mode: 0o600 });
        const files = Object.fromEntries(
          ["codex-native-guardian", "codex-guardian-worker.mjs", "fixture-worker.mjs"].map(
            (name) => [name, hash(join(packageDirectory, name))],
          ),
        );
        writeFileSync(
          join(packageDirectory, "package-manifest.json"),
          JSON.stringify({ schemaVersion: 1, guardian: build, files }),
          { mode: 0o600 },
        );
        const packageManifestSha256 = hash(join(packageDirectory, "package-manifest.json")),
          nodeSha256 = hash(node),
          policy: GuardianPolicy = {
            enabled: true,
            producerEnabled: true,
            packages: [
              {
                packageManifestSha256,
                guardianElfSha256: build.elfSha256,
                nodeSha256,
                protocol: "guardian-v1",
                policyDigest: GUARDIAN_CONTROLLER_POLICY_DIGEST,
                metadataPolicyDigest: GUARDIAN_METADATA_POLICY_DIGEST,
              },
            ],
          };
        let service: GuardianService;
        const authority = openGuardianController({
          config,
          configSha256,
          home,
          stateDirectory: join(directory, "outer"),
          packageManifestSha256,
          guardianElfSha256: build.elfSha256,
          nodeSha256,
          startupAttestation: () => {
            if (!host) throw new Error("Fixture host not ready");
            return host.startupAttestation();
          },
          fetchImpl: async (target, init) => {
            expect(target).toBe(`${sessionConfig.hiveOrigin}/api/codex-host/guardians`);
            expect(init?.headers).toEqual({ "Content-Type": "application/json" });
            return Response.json(await service.execute(JSON.parse(String(init?.body))));
          },
        });
        host = await openGuardedHost({
          packageDirectory,
          packageManifestSha256,
          workerName: "fixture-worker.mjs",
          nodeExecutable: node,
          nodeSha256,
          workerCwd: home,
          stateDirectory: join(directory, "outer"),
          bindingDigest: sha(
            JSON.stringify({ schemaVersion: 1, configSha256, packageManifestSha256 }),
          ),
          startup: {
            schemaVersion: 1,
            type: "start",
            nonce: Buffer.alloc(32, 1).toString("base64url"),
            configSha256,
            packageManifestSha256,
            nodeSha256,
            port,
          },
          authorizeAdmission: authority.authorizeAdmission,
          authorizeDrain: authority.authorizeDrain,
          controllerIdentity: authority.identity,
          controllerBootstrap: authority.bootstrap,
          metadataAuthority: authority.metadataAuthority,
        });
        expect(authority.identity("0".repeat(64)).identity.lifetimeId).toBe(
          host.state.guardian.lifetimeId,
        );
        async function app(path: string, body: unknown, origin?: string) {
          return new Promise<Response>((done, reject) => {
            const request = httpRequest(
              {
                hostname: "127.0.0.1",
                port,
                path,
                method: "POST",
                headers: {
                  Host: new URL(binding.appOrigin).host,
                  "Content-Type": "application/json",
                  ...(origin ? { Origin: origin } : {}),
                },
              },
              (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk) => chunks.push(chunk));
                response.on("end", () =>
                  done(new Response(Buffer.concat(chunks), { status: response.statusCode })),
                );
              },
            );
            request.on("error", reject);
            request.end(JSON.stringify(body));
          });
        }
        service = new GuardianService(db, sessionConfig, policy, "19".repeat(32), {
          env,
          resolveWorkspace: async () => binding,
          transport: {
            identity: async (_b, nonce) => {
              const r = await app("/guardian/identity", { nonce });
              expect(r.status).toBe(200);
              return r.json();
            },
            bootstrap: async (_b, grant) => {
              const r = await app("/guardian/bootstrap", { grant });
              expect(r.status).toBe(200);
              return r.json();
            },
          },
        });
        expect(
          (await app("/guardian/identity", { nonce: "1".repeat(64) }, "https://foreign.invalid"))
            .status,
        ).toBe(403);
        expect((await app("/guardian/identity?x=1", { nonce: "1".repeat(64) })).status).toBe(403);
        const result = await service.provision(
          { hiveUserId: user.id, coderUserId: user.coderUserId },
          binding.workspaceId,
        );
        expect(result.enrolled).toBe(true);
        expect((await app("/fixture/prepare", {})).status).toBe(200);
        const admission = await db.codexGuardianAdmission.findFirstOrThrow({
          where: { runtimeId: result.runtimeId },
        });
        expect(admission.phase).toBe("checkout");
        expect(admission.checkoutBinding).toMatchObject({
          projectId: project.id,
          preparationIntentId: request.taskId,
        });
        const launched = await app("/fixture/launch", {});
        expect(launched.status).toBe(200);
        const approval = await launched.json();
        expect(approval.approvals[0].firstNative).toBe(true);
        expect((await app("/fixture/launch", {})).status).toBe(403);
        const runtime = await db.codexGuardianRuntime.findUniqueOrThrow({
          where: { id: result.runtimeId },
        });
        expect(runtime.nativeLaunchId).toBe(approval.nativeLaunchId);
        expect(runtime.producerApproved).toBe(false);
        expect(await db.codexHostRegistration.count({ where: { ownerId: user.id } })).toBe(0);
        expect(await db.deliveryManagerBinding.count({ where: { ownerId: user.id } })).toBe(0);
      } catch (error) {
        primaryError = error;
      } finally {
        if (host) {
          try {
            const result = await host.abort();
            cleanupSafe = result.held !== true;
          } catch (error) {
            shutdownError = error;
          }
        }
        if (!cleanupSafe && !shutdownError)
          shutdownError = new Error(`Fixture shutdown uncertain; retained ${directory}`);
        if (cleanupSafe && !primaryError && !shutdownError)
          rmSync(directory, { recursive: true, force: true });
      }
      if (primaryError && shutdownError)
        throw new AggregateError(
          [primaryError, shutdownError],
          `Primary fixture failure and shutdown uncertainty; retained ${directory}`,
          { cause: primaryError },
        );
      if (primaryError) throw primaryError;
      if (shutdownError) throw shutdownError;
    }, 60000);
  },
);
