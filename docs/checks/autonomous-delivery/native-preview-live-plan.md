# Next native Preview acceptance

Source and local PostgreSQL proof do not establish live publication. Production
remains under the owner's merge/cutover approval. This plan uses one Worker,
`hive`, and leaves its automatic branch builds enabled.

1. Commit the reviewed controller/publisher, then pin that exact source. Back up
   both existing isolated Preview databases; apply additive migration45 with the
   repository migrator and verify prior rows, all migration checksums, append-only
   grants and the old application's native-database CONNECT denial. No production DB.
2. Add a default-off, dispatch-only build job to the existing registered `ci.yml`;
   it calls the reviewed builder at a literal SHA. Enroll its exact caller blob and
   obtain a completed first-attempt run and immutable artifact for the selected SHA.
3. Use a dedicated publisher branch with a minimal reviewed `ci.yml` dispatch caller
   at the same existing workflow path. Prove dispatch reachability with publishing
   disabled and no credentials. No merge to main or publisher `push` admission.
4. Protect the publisher branch and restrict `hive-native-release` environment to
   that exact branch. Pin caller context SHA/ref, publisher reusable SHA, explicit
   named secrets and fixed selectors. Read back these settings before enabling.
5. Enroll a separately reachable trusted controller Preview under `hive`; it must
   remain available while the candidate Preview is replaced. The candidate keeps
   release authority disabled. The controller and database role remain operator
   trust boundaries; this does not claim isolation from arbitrary application code.
6. Supply separate account-scoped Cloudflare Workers Scripts Read and Edit tokens,
   with finite test expiry. Controller receives Read only; protected publisher
   receives Edit only. No billing/zone/DNS/token-management permissions are required
   in either runtime. The connected Cloudflare OAuth currently returns403 for
   account token management, so it cannot create them automatically. Existing
   Workers Builds credentials are not repurposed or extracted.
7. Bind the first-baseline permission to the exact test owner/task/source/artifact,
   with finite expiry. Exercise grant, byte-only publication, authenticated receipt,
   independent readback and sampled health. Until it passes, recovery is unavailable.
8. Publish a distinct accepted candidate, then rehearse sampled regression and a
   new upload of the retained compatible baseline. Exercise observed automatic-writer
   drift/hold without claiming atomic CAS. Lost native acknowledgements remain held;
   do not repeat writes to manufacture a result.
9. Preserve sanitized receipts and disable test authority. Retain the accepted
   baseline/artifact for the documented retention period. Record actual usage;
   make no plan upgrades or production changes.

Steps2–5 require concrete enrollment and actual reachability checks; no success
is implied by this plan. The full manager/child and shared-session browser pilot
also still requires a healthy test host. Its startup diagnosis is a separate
pending Infrastructure routing exception.
