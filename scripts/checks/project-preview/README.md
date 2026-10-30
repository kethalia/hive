# Project preview browser acceptance candidate

Preparation only until the primary approves the plan/budget, target preflight and
preview exposure window. This directory must not launch a browser in Software,
enable a flag, create a workspace, copy an owner credential, start a task or make
GitHub/template/workspace lifecycle writes. Browser execution belongs to the primary-created Browser Testing
workspace in the primary creation record. The primary retains cleanup ownership.

## Audit and required candidate

Deployed `e9230f136939e0749e0c77f85d62d91b53adae67` has project discovery,
workspace reads and the native gateway on; tasks, manager execution and generic
terminal remain off. Its UI incorrectly makes repository selection depend on
`tasksEnabled`, yielding an external GitHub anchor rather than project enrollment.
The separately reviewed UI correction must be committed/built/deployed and its
exact source/artifact identity pinned before this candidate can claim opening.
The current `/api/projects/open` already authorizes owner/session and discovery;
the harness must not bypass the UI through API-injected fixtures.

Open resolves the exact repository/account, binds owner metadata and enrolls the
project in the host controller. A fresh task-null project returns `awaitingTask`,
with no native thread or terminal session, and does not clone/start inference.
Opening an existing controller task can call its scheduling path. The primary
therefore must independently inspect and approve this exact target's task-null
state before granting the one open operation; a name match or browser assertion
is insufficient. A refusal/error is a failed or blocked result, never permission
to retry against another project or start preparation.

## Phase A: actual discovery and task-null open

Proposed shared ceiling: 200 forwarded HTTP exchanges and180 seconds, one login,
one project open, at most four repository pages and one explicit repository
refresh. The final HTTP slot is reserved for one fixed logout cleanup. Count
before forwarding, including bootstrap, assets, redirects, RSC requests and any
direct Playwright API call. No automatic failed-run retry. Any revised budget is
a new primary-approved plan; it does not reset the earlier aggregate ledger.
The required private `priorForwarded` scope field (integer0–198) precharges all
primary smoke exchanges. The original failed smoke spent5; the corrected smoke
added7 after one separately preserved routing-propagation404, so the current
primary ledger is13, leaving187 slots
including the cleanup-only final slot. It must be refreshed from the actual
ledger before live execution rather than hardcoded by the driver. This ceiling
covers outer preview HTTP exchanges only. Backend Coder/GitHub/host/Neon fanout is
unmeasured here and excluded; the primary separately reviews its bounded paths,
fresh account headroom, CPU100ms setting and short exposure window. No aggregate
200-provider-request or total-account-cost claim follows. Task-null enrollment
under the approved empty controller creates no native prompt/manager callback.

1. Recheck the disposable's deployment/UUID/owner/template/creation time/current
   running build against its primary creation record. Inspect only installed
   Chrome and pinned Playwright1.61.1. Prepare into a private task-owned scratch;
   use `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` and the pinned package/lock if needed.
   Preparation navigates only a blank/synthetic local page, never the preview.
2. Receive exact `email`, `password`, `previewBearer` through primary-private
   file→encrypted SSH stdin→driver stdin, memory only. No storageState, credential
   file, trace, console, raw page text or raw network body leaves the Browser.
3. Bootstrap only the fixed preview origin, open the fixed-host credential form,
   wait for its actual hydration handler, fill the two fields and perform one
   UI login. Require no arbitrary Coder URL input and a credentials-only body.
   Normal Hive login can mint/retain its own origin-bound Coder key; logout
   invalidates the Hive session, without claiming remote key revocation. The
   primary's rotation lifecycle remains responsible for that retained key.
4. Navigate the supported UI deep link
   `/workspaces?panel=projects&workspace=<approved-workspace-UUID>`. Its source is
   `GeneralWorkspace`'s existing panel routing. Use the `GitHub projects` region,
   `Search loaded repositories` label and exact `kethalia/hive` repository button.
   Require account/repository IDs from the browser's real discovery response to
   equal the independently pinned primary plan; never infer GitHub identity from
   a display name. Search locally and verify a deliberately absent search gives
   the existing no-match state, then restore the exact repository search.
5. Click that exact repository once. Validate the actual open request has only
   workspace/account/repository/request IDs and the response is exact owner-target
   project, phase`awaitingTask`, currentTaskId/nativeThreadId/terminalSessionName
   all null. Require the actual project UI and disabled-task message. No task
   description, Start/Retry control, task/status request, clone, generic terminal
   or model prompt is allowed in this phase.
6. Resize the same authenticated page to390 and back1440; check horizontal
   overflow without screenshots containing repository/account data. Logout once
   with the same bounded cleanup contract and record its outcome. Failure after
   login attempts that cleanup within the remaining budget before closing the
   request context/browser. Preserve a sanitized failed result; no hidden retry.

Network policy permits only the exact preview origin, fixed auth/bootstrap,
read-only dashboard/static assets, fixed safe discovery resources, approved
workspace repository pagination and that one exact enrollment body. Block all
Next-Action, task/delivery/mutation/upload/voice/terminal endpoints, foreign
origins, popups, downloads, service workers and all WebSockets in phase A. A
redirect is inspected without following it before another counted allowlisted
exchange. Export only fixed stage/status categories, counts, booleans, immutable
scope IDs or their digests, and source hashes; no private URL/query/header/body.

## Phase B: shared native session remains pending

A fresh task-null open has no conversation. One prompt in an unrelated CLI does
not create the controller's project→registration→native-thread→tmux mapping.
F04 acceptance requires a separately authorized real registered project pilot,
with its exact owner/workspace/build/project/server/thread/tmux and kernel native
PID/start identity independently recorded. No fixture, adoption or changed flag
may substitute for this production trust path.

When that pilot exists, reuse phase A's scope/budget wrapper with a separate
reviewed policy that allows only its session/terminal grants and same-origin
project WebSockets. Bounded read-only history/subscription and at most one fixed
nonmutating native prompt must be explicitly approved before network. The prompt
must forbid tools/file edits/Git/network and request a unique fixed marker; its
completion remains account-backed inference, not read-only access.

Proof must compare facts rather than pixels: the UI grant binding and received
history/event IDs must equal persisted registration and host supervisor mapping;
the exact marker/turn/item appears in conversation and the already-existing tmux
CLI attached to that thread. Before/after reconnect and terminal tab switches,
assert the same native server PID+kernel start time, serverInstanceId, threadId,
tmux session identity and existing process count, with no new native start. Force
only the approved browser session socket closed, obtain a new grant and require
history reconciliation with stable turn/item IDs and no duplicate marker. A
terminal frame/CLI registration alone is not proof of model execution or of no
background writers. Do not claim kernel quiescence or release any writer hold.

Phase A's result must explicitly keep conversation, reconnect, terminal and native
prompt checks `pending`. Phase B cannot turn green until the primary independently
joins the actual browser facts and fresh host/persisted evidence. No current live
proof, deployment activation or inference is represented by this preparation.

## Prepared files and execution guard

`remote.py` defaults to `prepare`. It revalidates the primary creation tuple and
running Browser build, installs only pinned Playwright1.61.1 with browser downloads
and install scripts disabled, checks policy/syntax and opens/closes only a
synthetic page. `preparation.json` records that limited result; it is not a live
preview pass or cleanup authority. The private preparation receipt remains in
the primary's `/tmp/hive-epic-coder-auth/project-browser-preparation.json`.

```sh
python3 scripts/checks/project-preview/remote.py
node --test scripts/checks/project-preview/policy.test.mjs
```

The driver is hard-pinned to the approved workspace22c4f094-46f0-4a76-86ca-37ad74254872,
repository1183966024 and GitHub account62855857. It uses the current source's UI
labels and deep-link contract. Dashboard workspace loading is an SSR read action;
client discovery uses GET JSON routes. Opening this panel has no required browser
Next-Action caller, so all Next-Action traffic remains denied.

A live run additionally requires reviewed source and primary-owned private scope
JSON (`schemaVersion`, `sourceRevision`, `workspaceId`, `repositoryId`,
`providerAccountId`, `preflightDigest`, `expectedAppVersion`, `expectedAppBuild`,
`priorForwarded`).
The exact deployed app-version response must match the latter two values; the
primary independently joins source/artifact/deployment identity and the fresh
task-null host/database preflight. A digest in this scope does not authorize
enrollment by itself. Credentials are a separate private JSON with only `email`,
`password`, `previewBearer`. Both files require regular single-link owner-only
files, without symlink traversal. They are never copied to Browser disk.

Only after primary approval and new UI deployment:

```sh
python3 scripts/checks/project-preview/remote.py run --approved-live --scope-file <private-scope> --auth-file <private-credentials>
```

Before SSH, an exclusive fsynced primary attempt receipt records an unknown
outcome. It prevents an automatic second run/budget reset even if the driver or
transport fails. Preserve this receipt and the sanitized failed result; a revised
attempt needs a new explicit primary review of the cumulative budget. The wrapper
also exits unsuccessfully when the driver's result is false. Neither wrapper nor
driver can stop/delete the disposable; completion and cleanup remain with the
primary using its original installed-wrapper receipt.

## Recorded Phase A outcome (2026-10-30)

The reviewed a92e305 deployment passed the final real browser run. Evidence is
`docs/checks/autonomous-delivery/project-preview-browser/browser-a92-final.json`.
The final run forwarded55 exchanges,148 cumulative across all smoke/browser attempts;
all three browser logins logged out successfully. Backend fanout is not measured.
The first browser pin mistakenly selected the separately preserved Node `.next`
build; the actual Cloudflare `.next-cloudflare` and packaged server agree on
`f5509172-bd87-46df-a7eb-ce8b8c4014ae`. The second run met every functional check
but blocked the ordinary marketing-root RSC prefetch. The reviewed final policy
allows only root GET with an optional single bounded `_rsc` selector. Both earlier
failures and primary retry decisions remain preserved; no counter was reset.
No task, model inference, WebSocket or checkout was created. Project enrollment
exists in the preview DB/controller with a null task. Both Workers are private
again. Phase B and the registered native-manager pilot remain pending.
