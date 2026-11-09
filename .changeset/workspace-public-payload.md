---
"hive-web": patch
---

Restrict workspace list, detail, and creation responses to the public workspace summary,
including nested build, job, and health fields. This keeps Coder agent environment
variables, application commands, and other provider metadata out of action responses,
discovery JSON, and initial workspace page props.
