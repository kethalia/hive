# Cloudflare voice transport candidate evidence

The candidate is off by default. It preserves browser microphone consent and routes signaling through a freshly authorized, owner-only Coder app to a pinned host package. Audio stays in the browser WebRTC connection. This is local evidence, not live account or browser acceptance.

The Worker rechecks the session and workspace owner/build binding during an active stream; on authorization, preview or session expiry it asks the accepted voice session to stop before closing the control connection. Cancellation during startup waits for the start result and watches for the same thread closing; rejected, closed or uncertain starts are never stopped because they may belong to another client. A timed-out start could leave an orphan if proxy disconnection does not end it, and events may race a new external call; real Codex behavior remains a release gate. The host uses signed one-use short-lived tickets and a per-process identity, fixed RPC methods, bounded frames and a shared per-thread flock. The host, read service and voice use root-owned, image-baked public archives and installers. Each template projects a public request and exact image asset hashes through a bounded read-only Downward API annotation; the fixed-kind launcher verifies both hashes before reconstructing the unchanged installer input. Voice is enabled only for the software profile. Packages and credentials do not enter annotations, and no ConfigMap is required.

Validation:

- 69 focused Vitest cases passed for voice, the Worker route and scoped app cookie exchange, including bounded pagination, malformed and duplicate thread lists, concurrent admission, binding changes, revoked sessions and cancellation.
- The three image-bootstrap tests passed, including mismatched archive and installer pins, duplicate fields, archive injection and oversized requests. The projected requests are individually capped at 16 KiB; image archive bytes are never embedded in pod metadata. At the bootstrap checkpoint, 105 template checks and the profile drift check passed. Subsequent concurrent host runtime edits made the host archive stale; a new synchronization and checks are required after that work freezes. The actual image-launcher test also passed in an isolated user/network namespace with root-owned fixture assets. An isolated actual installer run with `HIVE_VOICE_INSTALL_NATIVE=1` started and reused the same verified process. The fixture uses a synthetic Coder manifest identity and an independently checked Node binary.
- `pnpm test:voice:workerd` exercised the real portable client in local workerd, a synthetic Coder app-cookie exchange, signed identity and native WebSocket upgrade, the local host helper and a framed synthetic Codex proxy. No browser or account-backed model inference was used.
- The official cached Go 1.26.10 toolchain ran `go test ./...` in `tools/workspace-identity` with `GOPROXY=off` and passed. The image must be rebuilt from this source, pinned and independently verified before voice can be enabled; the current deployed verifier does not yet recognize the voice app.
- `pnpm exec tsc --noEmit --incremental false` passed with the concurrent acceptance-repair changes present. Template-profile drift is expected until the coordinating agent synchronizes all profiles.

Production and review gates remain: independent review, resynchronization after the active host changes, Cloudflare deployment configuration and manifest pin, Terraform/provider validation and a ConfigMap-free Coder build, new image provenance and deployment, real owner-authorized Coder app exchange and Codex proxy, and browser voice/microphone acceptance. All image build jobs now verify the six baked assets and launcher against source and enforce root ownership and non-writability before publication; preview retains the verification JSON in its job summary. No image was built or published in this local proof. The current tests do not prove those gates.

Package and installer source hashes below are SHA-256 over exact bytes. The files are listed to support review; the coordinating agent may regenerate the copied profile artifacts after this snapshot. The uncompressed package manifest digest (the Worker pin) is `cb0abe2c024ddec95d28a2f0762d4a87097b0efbbd95b73da1f254e39fcb313f`.

| File | SHA-256 |
| --- | --- |
| `deploy/cloudflare/app/worker.ts` | `f95e1410ab14777a45de195ac4537b2ae90321c89761fb581641d75b590fb4c1` |
| `deploy/cloudflare/app/voice-runtime.ts` | `b83a603561a83a80f381fffa14d5d89b6bb3b4384140f221e118b918ee83c6c2` |
| `package.json` | `05104a2207617668b05a7844936fc30c1be6acd3e7b524b5fe4fd3142104502b` |
| `scripts/build-workspace-read-package.test.mjs` | `8c04e6e26623a61a44f3581f5f2cd8036d6cea8c6c5ca392aa0a700c1e89f91b` |
| `scripts/sync-workspace-profile-templates.mjs` | `61866df4ab6d6b4551585d7644a76713aa2e28f97dc62a9253e17e97dc2c3ab3` |
| `src/lib/codex-session/bootstrap-delivery.server.ts` | `b020b2c13bedaad496c967892f0ef8f6a1847242d8b01fe65092a5ea11306eec` |
| `src/lib/codex/voice-connection.ts` | `a82a056d872aba30a0e08d0b99556e780558a7da0765293b6477d9d3b167bade` |
| `src/lib/codex/voice-portable-client.server.ts` | `e23501956aacbfaea635db791611892489f89656f57d11d429c93c84e21ce0c9` |
| `src/lib/codex/voice-rpc.ts` | `050627015da45c2850fd94a2d6e7e57c91e91a7c5d6d9519c1b163d7addc2429` |
| `src/lib/codex/voice-session.ts` | `e96a5682139dcb6c14d296e67b5fcd6b5b678dd4e2ba614eec5ae898373b35ea` |
| `src/__tests__/lib/codex-session/bootstrap-delivery.test.ts` | `1210d9881488628e65b5643bf3a9b2c9a9824aa582b1d45a7863fddbca80bb07` |
| `src/__tests__/lib/codex-voice.test.ts` | `738432aafbf8ac02a002aa90e46b56094ac7bb247ba38999c16bacb40992d0e4` |
| `src/__tests__/lib/codex-voice-route.test.ts` | `0f2ffb9d38f19f30efae82603378a5e561462ccd53f8e59f23044e82031146fe` |
| `src/__tests__/lib/codex-voice-portable.test.ts` | `54b14efacaaae77033cfd02ae6e3ad7c9d72276d583f6cb639e624840edadbcb` |
| `src/__tests__/lib/db/voice-runtime.test.ts` | `041bc0440f13f620ae86d316997288237044ca7bf93f6a5d95accc1399c6a5dc` |
| `templates/ai-dev-k8s/main.tf` | `9afddfb422408cf05f0c42d24790974e3b8499dbe54673287a01e435ba4087c7` |
| `templates/ai-dev-k8s/hive-host.tf` | `5dad2ca6a8b4da5b597895a96bc2a9c60ad75cd10bd142c386cf6944d095751c` |
| `templates/ai-dev-k8s/hive-read.tf` | `909a72994ae98af2dfedb47537253405d001eec9c79e2fc9ffc47a84be860404` |
| `templates/ai-dev-k8s/hive-voice.tf` | `49f1b06f61a109e24ff12786ca139ea1374e982c890d4ad8580a1b2f52978e21` |
| `templates/ai-dev-k8s/scripts/install-voice.py` | `bd56ae1ede30c8f3685c5676abeb3fbde5497c43a57b8320a5dbe7003791d0d1` |
| `templates/ai-dev-k8s/scripts/install-voice.sh.tftpl` | `c69616eb28a7a6566fe96e98f8bfd3f9a4f2970f99be626d6656bc6a4d416e6e` |
| `templates/ai-dev-k8s/scripts/start-voice.py` | `68cfcddc611920d5b80e1b11b9f6afd4b89616ed3bce716d44bde7da831a3bcb` |
| `templates/ai-dev-k8s/assets/voice-installer.py.gz` | `7c80af8b9896b78769785461981f20866c34f3dcb07c44437970ebf22ec992cb` |
| `templates/ai-dev-k8s/assets/voice-installer.sha256` | `534a73e2edfcef2fc26c586d2ef7cef52c98754c2ac0f850b9719745a9b05a07` |
| `templates/ai-dev-k8s/assets/voice.manifest.sha256` | `7a58ee33de40de735ff4699f068abe4e6751b092f4998346c87f4f62f8d17190` |
| `templates/ai-dev-k8s/assets/voice.tar.gz` | `6a77644cdca2385a06bb3d179737cc4b341a2ce5cc8a31bdfca8ac89a9b53db1` |
| `templates/ai-dev-k8s/assets/voice.tar.sha256` | `b6f1dc168051faac13fe4535753300c7355e6c2178649e33b948c3dea895e90c` |
| `tools/workspace-identity/main.go` | `3ca609576c639a539e46a87b4effcfdd910848d366973a44578499ae9fe5b0e5` |
| `tools/workspace-identity/main_test.go` | `c2bfe2d3f6a3e7d1ec3ce12fc1fb1b84e22b8577752f3e7d809f4083d966832e` |
| `scripts/voice/build-package.mjs` | `29cdd72520ccecdc904fe94a3010f7f166360f8f747d56fefa499b08f2ab1d8d` |
| `scripts/voice/build-package.test.mjs` | `eb412963b6720221a5f125c3447741ecd2217d5ead61e2c4a6c6e531759e50f4` |
| `scripts/voice/install-voice.test.mjs` | `46cfc9d66b5cf24706c20b5adfd7322ac6ab77a318ce4ef2366954368684ccdf` |
| `scripts/voice/native-install-fixture.py` | `40223ef112cba9f151abc8b678edcd6e9f7b640dbaa4952b34ba6965098e0d7b` |
| `scripts/voice/native-install.test.mjs` | `80e088af4692567b251f649701edbc449d421ca67bd4c6ad1993d0664b0dd5d7` |
| `scripts/voice/run-workerd-proof.mjs` | `4279c796df3f47d6aa8d00729469269f5caf037f8fe0659acba40d3bccffca58` |
| `scripts/voice/template.test.mjs` | `5674d3782e44702b1b329be493a1f655c6c8a239fcde8b723bf09b0079f86be1` |
| `scripts/voice/voice-host-start.mjs` | `0a0ac597dcee1888b71445ab5ef9b0dfb4c84d0c8dbdc8c1326d15f18e86d269` |
| `scripts/voice/voice-host.mjs` | `3ef47413863a43efee2c665deb4bcc3932ccf720f0f87018b90abc5fae54f093` |
| `scripts/voice/voice-host.test.mjs` | `93b431828fccd09bfc014744e93176ad553751bb463d3df77bbf544805fbd306` |
| `scripts/voice/voice-startup.test.mjs` | `2aedb274da100f00d389fe1403a870f492d29a6f2b06ecf4cc1158002bf0c668` |
| `scripts/voice/voice-workerd-fixture.ts` | `002cd4e050c0b9462530123c508b917e451cc7a75fa3d571accc45fdbcced86c` |
| `docker/hive-base/Dockerfile` | `da743141bea95d9fd56095c4880a63a2d5c0c87c042e766256ad3d441e09868f` |
| `docker/hive-base/hive-template-bootstrap.py` | `511de1cd8fe3539b32748c8eaf55d62a11b6047669684618c8e032d979296390` |
| `.github/workflows/build-base-image.yml` | `6f85b4cc37aa5eb87026d0160edb800b6576ad1c424b789aff7fdf9bd8fda027` |
| `scripts/voice/image-bootstrap.test.mjs` | `0d8d41c49ee0aeec9f9220feaaacc7a0a1f9451c37641debb28acc39ff229057` |
| `scripts/build-codex-host-archive.test.mjs` | `f4cdf1426f8bdf68334a137e61eff38980bda1035ae1892d7b01f57b8a9923dd` |
| `scripts/verify-workspace-profile-templates.test.mjs` | `ebfbe46aa24434cf46a18df329fca5c1cfc4c74326b7eea9efc2a383c4d0a671` |
| `scripts/agents/test_codex_host_install.py` | `258b7f484921145fee66bf7a2561f1f949c9afe0625eeb0e3dc6a6e3afabc4d1` |
| `docker/hive-base/verify-template-image.py` | `f8aa7d571ffb7781b13f18bf9fed9837160b1f8a180e46bdb2e4a95b1574e51c` |
| `scripts/voice/image-smoke.test.mjs` | `21b8383bdadd4fee01439489a93bb85187fd5a09dc455d63b3bcfbf6b08dfeeb` |

## Parent integration checkpoint

Independent review accepted the final cancellation and image-bootstrap design. After the
completion runtime froze, the parent regenerated all five profiles and passed all105 template
checks and the drift check again. The staged runtime command passed449 checks with20 opt-in skips.
The actual image/provider/browser gates above remain open. See
[combined parent evidence](repair-voice-parent-review.json). The table above remains the earlier
source snapshot; the combined parent record pins regenerated artifacts.
