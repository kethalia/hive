---
"hive-web": major
"@hive/auth": major
"@hive/db": minor
"hive-auth": major
"hive-terminal": major
---

Move Hive to one server-configured Coder deployment and introduce the observable autonomous
delivery foundation. Login requests no longer accept a Coder URL. All credential-consuming
services require the same CODER_URL and reject sessions for other deployments, so web, auth,
and terminal services must be upgraded together. Existing mismatched-origin records are retained.

Cloudflare migration and autonomous release activation remain gated on complete preview validation,
recovery rehearsal, and operator-approved production cutover.
