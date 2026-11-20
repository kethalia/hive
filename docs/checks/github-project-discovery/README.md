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

To repeat the check, sign in to the preview as the workspace owner. Open **GitHub** with Cmd/Ctrl+K. In **Workspace**, choose an enrolled workspace and start it if needed. In **Connection**, choose **Connect GitHub** or **Reconnect**, enter the displayed code on GitHub, and return to Hive for confirmation. Hive uses the GitHub CLI login in the selected workspace.

Open **Repositories**, search by repository name and expand **Repository details**. Search covers the pages loaded in the window. Existing P03 bridges can still serve provider account requests and require the P04 package for discovery.

## Technical debt

- [ ] Replace GitHub CLI OAuth sign-in for managed workspace connections with GitHub App installation credentials. P04 uses the workspace's native GitHub CLI login with the CLI's default scopes (`repo`, `read:org`, and `gist`). The `repo` scope can grant read and write access across private repositories the GitHub identity can access. The current connection cannot limit the credential to selected repositories or read-only access. [GitHub CLI OAuth defaults](https://github.com/cli/cli/blob/v2.96.0/internal/authflow/flow.go#L27-L31) · [GitHub OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
- The migration should limit each workspace to approved repositories and the minimum repository permissions. Use short-lived installation tokens and enforce the same access in Hive discovery, terminal `gh`, and Git over HTTPS. Verify that a read-only credential cannot push, unselected private repositories remain inaccessible, and expiry or revocation cannot fall back to a broader credential.

## Initial Coder-linked GitHub connection acceptance

The initial P04 implementation used Coder’s shared GitHub credential. The hosted preview showed the linked GitHub account while the dedicated repository workspace was stopped. In **Reconnect GitHub**, Hive issued a fresh device code, opened GitHub’s official verification page and waited for the account holder. After approval, Coder accepted the exchange and Hive read back the same GitHub username. The **Repositories** tab then passed search, identity details, loading a second page and refresh. The existing checkout retained its HEAD and uncommitted file.

The initial **Connect GitHub** presentation used a simulated disconnected status against the hosted window to exercise issuance and cancellation while preserving the existing test-account link. Component tests exercised first-time approval and reconnection, including an intermediate pending poll. Route tests covered denied, expired and slowed exchanges, and rejection of attempts from a different session.

## P03 production check

Production Hive build `e544006d-9940-4c52-ab11-ced82c588f97` accepted the Coder OAuth sign-in. In the isolated production-configured workspace `codex/hive-p03-prod-check`, both Codex and Claude reported signed out, returned their official sign-in prompts and confirmed cancellation. Completing provider consent, reconnect and signed-in usage were outside this production check. [P03 preview acceptance](../workspace-accounts/README.md)

The initial image pin could not start the merged bridge. The successful isolated build used the CLI digest `sha256:1b3fe81e7a0fd14cf11d28efe0170e22a597601e72f34624873d2e275ac4f12d` for merge commit `8dcbc435`. The active production template and the owner's running `ai-dev-01` retained their existing versions. [Production image pin PR](https://github.com/kethalia/hive/pull/454)
