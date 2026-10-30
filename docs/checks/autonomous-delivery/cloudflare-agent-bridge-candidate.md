# Cloudflare agent tools transport candidate

Snapshot base commit: `494cf3e0dc01455a282a8a4d238ec71126adcf08`. These hashes describe uncommitted candidate files, including a shared Worker file also used by the delivery work. Recheck them before packaging or deployment. The template profile copies are synchronized at this checkpoint.

The Cloudflare path is explicitly disabled by default. When enabled it resolves the current owner-only `hive-agent` app and current Coder workspace/build before and after every request, uses fixed scoped application cookies, and exchanges one-use signed tickets and process-bound signed replies with a pinned local helper. Only inventory, sessions, install/disable tracking, configure Coder and resume are allowed; the caller cannot supply a command or source. Mutation errors, lost responses, or failed post-mutation revalidation are reported as unknown outcomes without automatic retry. The original Node SSH behavior remains in place.

The installer uses a workspace-owned private package and fixed Node/Python processes, root-owned image bootstrap assets, a small hash-pinned Downward API request and authenticated Coder provisioner identity. It captures trusted startup `CODEX_HOME` and `CLAUDE_CONFIG_DIR`, verifies package and helper hashes, and fails closed on an unverified listener or changed live configuration. A rebuilt image is required for the new `agent-tools` identity kind and baked package. The default deployed image does not contain this new service.

Local evidence at this checkpoint:

- 56 focused Vitest cases passed across agent actions, scoped app-cookie exchange and action/discovery gate behavior. Eight focused host, installer, package and action-manifest tests passed, including owner/build binding, replay, fixed operations, helper tampering, oversized output and missing response handling.
- `HIVE_AGENT_INSTALL_NATIVE=1 node --test scripts/agent-bridge/native-install.test.mjs` ran the real installer in isolated user/network namespaces, verified startup and idempotent reuse, with synthetic Coder identity and custom Unicode configuration directories.
- `node scripts/agent-bridge/run-workerd-proof.mjs` ran actual local workerd with real owner/app/build resolution and scoped Coder-cookie exchange against synthetic Coder responses, signed protocol and the local service with the actual `agent-tools.py`. It exercised sessions, tracking install/disable, preserved unrelated hooks, denied a wrong owner before app access, and returned unknown outcome on a changed build after a mutation. No account-backed inference or cloud mutation was used.
- `pnpm test:templates` passed 105 tests, `pnpm templates:check` passed, and official cached Go 1.26.10 `go test ./...` passed offline for the new `agent-tools` identity kind. `pnpm exec tsc --noEmit --incremental false` passed; concurrent D09 edits can change the shared tree.

These checks do not prove installed real Coder provisioner identity, image publication, scoped app-cookie exchange against a real Coder deployment, current owner/build revocation, live CLI/MCP inventories, conversation resume, custom login-shell environment propagation, or browser acceptance. Terraform/provider review and an independently reviewed image/build pilot remain required. Do not enable the bridge or claim full feature parity before those gates. Notifications use a separate authority and are not included.

Agent package manifest SHA-256: `d9bb8d648a7d2dfe72a5d489fe86b53217a6ef468bcf952443b04911bf4e1714`. Fixed helper SHA-256: `baf75cae5e3779867e19ac971bbadcfb3e82dc2e61e46b1332d5b4614141d8f1`. Source and generated file SHA-256 values:

| File | SHA-256 |
| --- | --- |
| `.github/workflows/build-base-image.yml` | `e378e9750e29c11da8a786d25e87d722a8c77a3f709caf46f059ea4b216b6875` |
| `deploy/cloudflare/app/portable-actions-build.mjs` | `f6890fbe421eefa774cdf619ce5b6dd46cfe2c5a3346004fb08af40a48537cc2` |
| `deploy/cloudflare/app/portable-actions-build.test.mjs` | `cfd263cf9a41acae0adafc0491ebc8c492c01f72e68ea29bc1ca44c0cce5c9b6` |
| `deploy/cloudflare/app/portable-actions.ts` | `6f40b8b166d03e8ad9f011b4b65ca88a21203eb089fa255779612ba177e66e69` |
| `deploy/cloudflare/app/worker.ts` | `b0851fcf40d6b422695e22229ab73dd08b1ad002d862a8fe70f3100034c03415` |
| `docker/hive-base/Dockerfile` | `3870b4c6e031f1cd36e3e34c3689adb1feca89424d32a1ad22cf7c38b3e377fa` |
| `docker/hive-base/hive-template-bootstrap.py` | `fec59e67503147068c089cdbfbccf7768bc4e0d319045fb5e76eccde7b3032d1` |
| `docker/hive-base/verify-template-image.py` | `d3ef29e53f8ba595ab1b0a0056bc3dada5f4b9e95c5977de707cfdca67be1a7e` |
| `scripts/agent-bridge/build-package.mjs` | `777bf676d3af3781ba0e98bcac37c570129f14d35f3c8bc088b51bdaa0e0e0a3` |
| `scripts/agent-bridge/fixture.worker.ts` | `4e86a3d842cb7c6f649c94bfdaac900a757053e54cdd7545cf8cd3c673625cd6` |
| `scripts/agent-bridge/host.mjs` | `8415580f1773915658722397ebbb5344c4b72b86423c0e1e40019475f8a4d122` |
| `scripts/agent-bridge/host.test.mjs` | `1d3235ecec5bbfd1ba198b4c3dfa86f50a6b2af66ce9044daa3beeda796d8a46` |
| `scripts/agent-bridge/install.test.mjs` | `47d97b38ceaf681882f65d3a2211598c90b4129ff2e786275180f90f3f0fba85` |
| `scripts/agent-bridge/native-install-fixture.py` | `41473f9b8c901fd0b68feb1909c256cb10ab37d0b5179d1cc9473e3e6eefc5f5` |
| `scripts/agent-bridge/native-install.test.mjs` | `c813025badcf364ce1f6ff05eba2ae622151888507c8a43ef5034c8c373cbe48` |
| `scripts/agent-bridge/package.test.mjs` | `ec25ff28da55b80e0248bb53ba7a99a0d519842264ff1a08594cd07c29fb3744` |
| `scripts/agent-bridge/run-workerd-proof.mjs` | `8be7063e1fe88985190093528de9ed04a4a7b8414add5c06a55fa74c5ee80f50` |
| `scripts/agent-bridge/start.mjs` | `f2598e55e88298e5a3de4a823b10afe9835acf9625f53112aad0ce331339e980` |
| `scripts/sync-workspace-profile-templates.mjs` | `15a016fef4a234f4edcc9b3b21962e8193fc2d7503e561bd2635ef9efd54dc7d` |
| `scripts/verify-workspace-profile-templates.test.mjs` | `b9459aa48d74516dbc81ed9c9029efad5ae63dcca0662e140ef8c79f5e64595d` |
| `scripts/voice/image-bootstrap.test.mjs` | `8b4f13a805757842c89ab9d15c7ee4955030d6fed89e191d303d7a6118aa392f` |
| `scripts/voice/image-smoke.test.mjs` | `aea1541e7ca14dc75a118f2bca4fa9e17ae2e677ff249fe87e8ab23e45fc073c` |
| `scripts/voice/template.test.mjs` | `73773add806895abd5af25b76f5a72510458e37b20659d45785cc0b3613d0ae8` |
| `src/__tests__/lib/agents/portable-client.test.ts` | `886e48c468c150d84c65dd1ac320f3510e0073844d9011241896c77e866ef66f` |
| `src/__tests__/lib/agents/portable-config.test.ts` | `fec2c3d6f4b151e0f8fb7e9d3bd05ce5dcde32707c14e91cfddda2f95fcf8684` |
| `src/__tests__/lib/agents/portable-service.test.ts` | `ecd84312ccec708ae679e77d07459e2589db30ea0fd05136204a6143b0e5fb66` |
| `src/__tests__/lib/agents/workspace.test.ts` | `60bda6247ebe1ef1cf1d3705a3fae11b282acfcd1b4fe3904c4487b3fc0f9ce1` |
| `src/__tests__/lib/codex-session/bootstrap-delivery.test.ts` | `5224552c6d3d1e3b24943591d1fd0782364a2666cddbe7ce069d02ac6fe8fd11` |
| `src/__tests__/lib/db/portable-actions.test.ts` | `5b26f586e15885c57214a432dd2a78447b7ba24f70fda82334b14e5070390f21` |
| `src/lib/agents/portable-client.server.ts` | `bdc0057d0047375bfc8ba8cd41e5ca41201dfe84c3024524b5a8a3523c50079b` |
| `src/lib/agents/portable-config.server.ts` | `921345948e196e295706f88bfe2fd2c53980f5bd03a692ac7aadb4ee77abcabf` |
| `src/lib/agents/portable-contracts.ts` | `4819b9f9903eda74bafd1fa48853638cfc00d987df3b13f63019860303596188` |
| `src/lib/agents/portable-service.server.ts` | `f58dc1b0fb4e59314548a80447431d8224c7285b455a845ecf9987e075342cbe` |
| `src/lib/agents/workspace.ts` | `d4227b672d479b0f44d3b36ff4b172d4824b8bee80a41c12770bedddd107edbf` |
| `src/lib/codex-session/bootstrap-delivery.server.ts` | `fe8774be54cda14ea122534b1ee41b1278ec02cdb1a9e4a2a8e7b494655b541a` |
| `src/lib/templates/artifact-manifest.json` | `7afc70c279edfdff938ccbc48d7ea1dce6aea720a42c3cfd166d09daa4754b98` |
| `templates/ai-dev-k8s/assets/agent-bridge.helper.sha256` | `d7218a27f283d04726e3d0b154b46f4b01366758625272d47d0406808d51281d` |
| `templates/ai-dev-k8s/assets/agent-bridge.manifest.sha256` | `fec7e8d34ef471d6384de36cfa1da4176bda1a487c4220c46840c05410dad53f` |
| `templates/ai-dev-k8s/assets/agent-bridge.tar.gz` | `d8a5df26ff3ed572f6447589dae724d355eb21e5333a90f5d79a338b56d79910` |
| `templates/ai-dev-k8s/assets/agent-bridge.tar.sha256` | `c09c204bb2bea9179e8f6b581ab61736c462edb951c4d6c1d38f754808066d10` |
| `templates/ai-dev-k8s/hive-agent.tf` | `3965aa869d53a80c2642148345c71830fa32727910e91801ddd7e00a4719bb40` |
| `templates/ai-dev-k8s/main.tf` | `b3728f88a558ab91407a71f5e12d45ab738ec490628197f1cd42c8d0615828dc` |
| `templates/ai-dev-k8s/scripts/install-agent-bridge.py` | `73655d2e29658e715c589bc191122475cf72db73f95157007f2402164fc3bc5c` |
| `templates/ai-dev-k8s/scripts/install-agent-bridge.sh.tftpl` | `69cbb03aa2289761141a02c9a15c17564dd153cfbf54fca889bcd73a72bdbb77` |
| `templates/browser-testing/assets/agent-bridge.helper.sha256` | `d7218a27f283d04726e3d0b154b46f4b01366758625272d47d0406808d51281d` |
| `templates/browser-testing/assets/agent-bridge.manifest.sha256` | `fec7e8d34ef471d6384de36cfa1da4176bda1a487c4220c46840c05410dad53f` |
| `templates/browser-testing/assets/agent-bridge.tar.gz` | `d8a5df26ff3ed572f6447589dae724d355eb21e5333a90f5d79a338b56d79910` |
| `templates/browser-testing/assets/agent-bridge.tar.sha256` | `c09c204bb2bea9179e8f6b581ab61736c462edb951c4d6c1d38f754808066d10` |
| `templates/browser-testing/hive-agent.tf` | `3965aa869d53a80c2642148345c71830fa32727910e91801ddd7e00a4719bb40` |
| `templates/browser-testing/main.tf` | `b3728f88a558ab91407a71f5e12d45ab738ec490628197f1cd42c8d0615828dc` |
| `templates/browser-testing/scripts/install-agent-bridge.py` | `73655d2e29658e715c589bc191122475cf72db73f95157007f2402164fc3bc5c` |
| `templates/browser-testing/scripts/install-agent-bridge.sh.tftpl` | `69cbb03aa2289761141a02c9a15c17564dd153cfbf54fca889bcd73a72bdbb77` |
| `templates/electronics/assets/agent-bridge.helper.sha256` | `d7218a27f283d04726e3d0b154b46f4b01366758625272d47d0406808d51281d` |
| `templates/electronics/assets/agent-bridge.manifest.sha256` | `fec7e8d34ef471d6384de36cfa1da4176bda1a487c4220c46840c05410dad53f` |
| `templates/electronics/assets/agent-bridge.tar.gz` | `d8a5df26ff3ed572f6447589dae724d355eb21e5333a90f5d79a338b56d79910` |
| `templates/electronics/assets/agent-bridge.tar.sha256` | `c09c204bb2bea9179e8f6b581ab61736c462edb951c4d6c1d38f754808066d10` |
| `templates/electronics/hive-agent.tf` | `3965aa869d53a80c2642148345c71830fa32727910e91801ddd7e00a4719bb40` |
| `templates/electronics/main.tf` | `b3728f88a558ab91407a71f5e12d45ab738ec490628197f1cd42c8d0615828dc` |
| `templates/electronics/scripts/install-agent-bridge.py` | `73655d2e29658e715c589bc191122475cf72db73f95157007f2402164fc3bc5c` |
| `templates/electronics/scripts/install-agent-bridge.sh.tftpl` | `69cbb03aa2289761141a02c9a15c17564dd153cfbf54fca889bcd73a72bdbb77` |
| `templates/game-dev/assets/agent-bridge.helper.sha256` | `d7218a27f283d04726e3d0b154b46f4b01366758625272d47d0406808d51281d` |
| `templates/game-dev/assets/agent-bridge.manifest.sha256` | `fec7e8d34ef471d6384de36cfa1da4176bda1a487c4220c46840c05410dad53f` |
| `templates/game-dev/assets/agent-bridge.tar.gz` | `d8a5df26ff3ed572f6447589dae724d355eb21e5333a90f5d79a338b56d79910` |
| `templates/game-dev/assets/agent-bridge.tar.sha256` | `c09c204bb2bea9179e8f6b581ab61736c462edb951c4d6c1d38f754808066d10` |
| `templates/game-dev/hive-agent.tf` | `3965aa869d53a80c2642148345c71830fa32727910e91801ddd7e00a4719bb40` |
| `templates/game-dev/main.tf` | `b3728f88a558ab91407a71f5e12d45ab738ec490628197f1cd42c8d0615828dc` |
| `templates/game-dev/scripts/install-agent-bridge.py` | `73655d2e29658e715c589bc191122475cf72db73f95157007f2402164fc3bc5c` |
| `templates/game-dev/scripts/install-agent-bridge.sh.tftpl` | `69cbb03aa2289761141a02c9a15c17564dd153cfbf54fca889bcd73a72bdbb77` |
| `templates/infrastructure/assets/agent-bridge.helper.sha256` | `d7218a27f283d04726e3d0b154b46f4b01366758625272d47d0406808d51281d` |
| `templates/infrastructure/assets/agent-bridge.manifest.sha256` | `fec7e8d34ef471d6384de36cfa1da4176bda1a487c4220c46840c05410dad53f` |
| `templates/infrastructure/assets/agent-bridge.tar.gz` | `d8a5df26ff3ed572f6447589dae724d355eb21e5333a90f5d79a338b56d79910` |
| `templates/infrastructure/assets/agent-bridge.tar.sha256` | `c09c204bb2bea9179e8f6b581ab61736c462edb951c4d6c1d38f754808066d10` |
| `templates/infrastructure/hive-agent.tf` | `3965aa869d53a80c2642148345c71830fa32727910e91801ddd7e00a4719bb40` |
| `templates/infrastructure/main.tf` | `b3728f88a558ab91407a71f5e12d45ab738ec490628197f1cd42c8d0615828dc` |
| `templates/infrastructure/scripts/install-agent-bridge.py` | `73655d2e29658e715c589bc191122475cf72db73f95157007f2402164fc3bc5c` |
| `templates/infrastructure/scripts/install-agent-bridge.sh.tftpl` | `69cbb03aa2289761141a02c9a15c17564dd153cfbf54fca889bcd73a72bdbb77` |
| `tools/workspace-identity/main.go` | `2ad65a6c7714b6187ee41bca046a7c1ef1c7875a292aea7f6430b0563e3c91e1` |
| `tools/workspace-identity/main_test.go` | `b9f69056ae538771ca294c7d3483b7f7382357ed93022e26ee87ddbc04c11964` |
| `scripts/agents/test_agent_tools.py` | `eef26cbdc740869c378fd19ab2194fa8a95738d92e0b171d9235693b0f23910c` |
| `templates/ai-dev-k8s/scripts/agent-tools.py` | `baf75cae5e3779867e19ac971bbadcfb3e82dc2e61e46b1332d5b4614141d8f1` |
| `templates/browser-testing/scripts/agent-tools.py` | `baf75cae5e3779867e19ac971bbadcfb3e82dc2e61e46b1332d5b4614141d8f1` |
| `templates/electronics/scripts/agent-tools.py` | `baf75cae5e3779867e19ac971bbadcfb3e82dc2e61e46b1332d5b4614141d8f1` |
| `templates/game-dev/scripts/agent-tools.py` | `baf75cae5e3779867e19ac971bbadcfb3e82dc2e61e46b1332d5b4614141d8f1` |
| `templates/infrastructure/scripts/agent-tools.py` | `baf75cae5e3779867e19ac971bbadcfb3e82dc2e61e46b1332d5b4614141d8f1` |

The real tmux regression starts an existing server with stale config paths, then resumes both agents using custom paths and unset defaults. All four resulting processes receive the intended environment. This is local evidence; live Coder shell environment capture remains pending.

Parent checkpoint: independent review passed the tmux correction and21 real-helper tests. The historical table retains the shared D09 Worker bytes; only the agent-specific Worker changes are included in this checkpoint. Commit781bb9d additionally sets the image runtime directory to0555 and verifies traversal permissions; these two image file hashes supersede the table. Test commands now register agent host/install/native-install/package checks and `test:agent:workerd`. Live gates above remain open.
