---
"hive-web": patch
"@hive/db": patch
---

Add default-off owner-confirmed account maintenance using the existing guardian runtime. Preserve unfinished tasks, source history and writer reservations while closing an idle managed tree; require receipt-bound fresh enrollment and one-use execution epochs before resuming work.

Hold resume and fresh execution until previously started external actions and source-publication grants have factual outcomes; serialize new journal effects with owner maintenance pause.
