---
"hive-web": major
---

Install maintained OpenGSD packages in Coder templates and document workspace migration steps.

BREAKING CHANGE: Existing Coder workspaces created from the previous templates must be rebuilt or manually repaired so they stop resolving abandoned pre-OpenGSD packages and pick up the maintained `@opengsd` package shims.
