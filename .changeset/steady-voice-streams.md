---
"hive-web": patch
"hive-terminal": patch
---

Keep terminal voice calls connected through brief audio backpressure by dropping late PCM, reserving bounded capacity for controls, and retrying workspace relay controls when the broker queue is full.
