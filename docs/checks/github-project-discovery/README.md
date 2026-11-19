# GitHub repository discovery acceptance

On 19 November 2026, a Chromium session in the Browser Testing workspace exercised the hosted P04 preview with the dedicated Coder test account. The test used its existing GitHub connection and the workspace's signed discovery operation. [P04 preview](https://codex-github-projects-p04.hive-preview.kethalia.com)

| Check | Result |
| --- | --- |
| Access | An anonymous request redirected to Hive sign-in. Completing the Coder OAuth popup opened the workspaces page. |
| Discovery | The authenticated Worker route returned two different repositories on successive one-item pages. On refresh, the repository ID and provider account ID matched the first read. Responses specified private, no-store caching. |
| Browser | Opened **Browse GitHub repositories** from the command palette and selected the running test workspace. Search found a repository, displayed the empty state for an unmatched term, and cleared successfully. |
| Repository identity | Expanded **Repository details** and matched its ID, default branch and GitHub link to the discovery response. |
| Pagination | Clicked **Load more repositories** and observed a successful page-two request. Refreshed from the same window and found the original repository again. |
| Checkout preservation | Seeded a local Git checkout with an uncommitted file. Its path, HEAD and porcelain status had the same digest before and after browsing. The inventory contained one checkout both times. |

The test workspace was `codex/hive-p04-discovery`, with an inactive preview template version `p04-6c615e9d-check`. Its CLI image was published from `6c615e9d` at digest `sha256:7fc88d1e2ae7d2f9ee7b160a62401ec2b336826c3e1e1aea03e21aa30bf186fb`. The normal image workflow must publish matching workspace assets for production enrollment after merge. [Preview image build](https://github.com/kethalia/hive/actions/runs/44583249438)

To repeat the check, sign in to the preview as the workspace owner and start the enrolled workspace if stopped. Open **Browse GitHub repositories** with Cmd/Ctrl+K, choose that workspace, search by repository name and expand **Repository details**. Search covers the pages loaded in the window. Existing P03 bridges can still serve provider account requests and require the P04 package for discovery.

## P03 production check

Production Hive build `e544006d-9940-4c52-ab11-ced82c588f97` accepted the Coder OAuth sign-in. In the isolated production-configured workspace `codex/hive-p03-prod-check`, both Codex and Claude reported signed out, returned their official sign-in prompts and confirmed cancellation. Completing provider consent, reconnect and signed-in usage were outside this production check. [P03 preview acceptance](../workspace-accounts/README.md)

The initial image pin could not start the merged bridge. The successful isolated build used the CLI digest `sha256:1b3fe81e7a0fd14cf11d28efe0170e22a597601e72f34624873d2e275ac4f12d` for merge commit `8dcbc435`. The active production template and the owner's running `ai-dev-01` retained their existing versions. [Production image pin PR](https://github.com/kethalia/hive/pull/454)
