---
"hive-web": patch
---

Make terminal link menus compact on desktop and keep them open while moving the cursor to an action. Preserve larger touch targets, including on hybrid devices, and prevent repeated hover events from moving the menu. Dismiss menus when terminal scrolling, resizing, or output invalidates their linked content, including hidden OSC 8 destinations. Keep pending hovers separate from open menus and clear stale link tracking when a menu closes.
