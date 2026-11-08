---
"@hive/db": patch
"hive-web": patch
"hive-migrate": patch
---

Recover completed controlled database jobs through the existing scheduler without
renewing stale SQL proofs. Require the exact serving Builds identity before
activation, preserve immutable provenance for later job lookup, and bound the
post-response callback's SQL and provider work. Run source compatibility with
isolated native Preview bindings and shared disposable old/new crypto identities.
