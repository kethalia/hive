# Exact repository policy source base

The deployment-owned repository policy chooses the branch. The project view reports that branch and its observed commit; task start independently resolves it again and compares the expected commit before inserting an intent. Neither a browser nor a manager supplies a branch selector. A policy/catalog change between observation and pinning fails the existing policy-version/branch checks.

The new signed `/projects/resolve-ref` scope invokes the existing agent-scoped GitHub helper. It reads the exact `git/ref/heads/<branch>` endpoint and requires a single matching full `refs/heads/...` result with an object of type `commit`. It does not use commit expressions, tags, matching-reference lists or a fallback to the default branch. Stable account/repository IDs, canonical name and current permissions are rechecked. [GitHub's reference API](https://docs.github.com/en/rest/git/refs#get-a-reference) documents this exact lookup and missing-reference behavior.

An immutable intent retains its chosen commit if the remote branch subsequently advances. Source publication still uses the pinned policy's base branch; release eligibility must separately verify the current tested base. Existing default-branch behavior remains for unenrolled legacy tasks with the feature disabled. Disabling policy never downgrades an enrolled task's authorization.

Unavailable source preparation disables starting a task while preserving access to existing conversations. The shared native bridge also now forwards the previously implemented fixed task-retry endpoint. No new provider mutation, model command or checkout execution capability is introduced by reference resolution.

`repository-source-base-local/result.json` records exact source hashes and checks. These include actual PostgreSQL policy pinning, signed scope rejection, malformed refs and provider responses, UI submission of the selected commit, stale-commit rejection and readable conversations under malformed policy. Live installed-host and browser acceptance remain separate gates.
