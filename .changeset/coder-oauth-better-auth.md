---
"hive-web": minor
"@hive/auth": minor
"@hive/db": minor
"hive-auth": minor
"hive-terminal": patch
---

Use Better Auth for browser sign-in through the configured Coder OAuth application. Preserve Hive user identities, encrypt provider credentials, serialize rotating refreshes, and support local sign-out and Coder disconnect. Propagate OAuth bearer credentials through workspace APIs, commands, terminals, audio, and template publication.

Apply the additive Coder OAuth migration and scoped runtime grants, then configure the Coder OAuth client secret before enabling this release. Existing users complete a one-time Coder consent flow.

Open Coder consent in a separate browser window. Serve a self-contained HTML callback and keep the window open until Hive verifies its browser session. Recover through serialized same-origin session checks when popup notifications are lost or the user closes the window after consent. Preserve typed browser-navigation responses for existing callback flows.

Keep a visible workspace-loading state after successful popup sign-in until navigation completes, with a disabled button and accessible progress feedback.
