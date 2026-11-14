---
"hive-web": minor
"@hive/auth": minor
"@hive/db": minor
"hive-auth": minor
"hive-terminal": patch
---

Use Better Auth for browser sign-in through the configured Coder OAuth application. Preserve Hive user identities, encrypt provider credentials, serialize rotating refreshes, and support local sign-out and Coder disconnect. Propagate OAuth bearer credentials through workspace APIs, commands, terminals, audio, and template publication.

Apply the additive Coder OAuth migration and scoped runtime grants, then configure the Coder OAuth client secret before enabling this release. Existing users complete a one-time Coder consent flow.
