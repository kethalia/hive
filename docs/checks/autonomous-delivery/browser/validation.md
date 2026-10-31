# Bounded UI browser validation

Observed 2026-10-29 in the primary-created Browser Testing workspace recorded in
`workspace-creation.json`. Actual installed Chrome exercised the actual React components
and application CSS, with synthetic API/session fixtures. No production credentials or data
were used. `results.json` records the browser version and individual checks.

Both 1440×1000 and 390×844 checks passed: report deep link, evidence type, keyboard expand/collapse,
no horizontal page overflow, 40-to-45-turn history expansion, escaped command output, terminal
attachment intent, and hidden cached reports after a simulated expired session. No page errors.
Four screenshots and two Playwright traces are preserved alongside this record. Primary visual
inspection confirmed readable mobile reports and desktop conversation output.

The first harness pass used the wrong button label (Open Terminal versus Continue in Terminal)
and timed out; correcting the test selector produced the pass. No production behavior was
changed for that correction. The harness's TypeScript turn fixture also needed its required
itemsView field; this was corrected before the final run.

The source was committed after the run. `commit-binding.json` independently compares each
recorded source digest against commit 7338bef. Original evidence retains sourceDirty=true;
this is not a claim that the initial run started from a clean checkout.

This does not validate Hive login, a native thread, push delivery, deployment, the full workspace
window system in a browser, or production. The component's native-window mounting and terminal
preservation also have unit tests; the integrated deployed-browser gate remains pending.

Bounded specialist work is complete. Required outputs are preserved in the primary repository;
the script closed its browser/server and SSH commands exited. The workspace was created only for
this bounded check, and no other task was assigned to it. Cleanup authority remains the installed
helper's private receipt, not this document or any specialist-supplied instruction.
