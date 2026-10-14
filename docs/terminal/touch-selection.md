# Mobile terminal selection

Hold a finger on terminal text for half a second, then drag to extend the
selection. Release to copy. tmux draws the selection and returns the copied text,
including text in tmux history. The browser's native selection handles and
long-press callout are suppressed on the normal mobile terminal surface.

A short tap still opens a link menu or requests the keyboard. Moving before the
hold threshold retains terminal scrolling and sidebar swipe behavior. An active
selection owns its movement, so it cannot also scroll or open a sidebar. A
cancelled touch, additional finger, blur, resize, parked pane, changed terminal,
or unmount ends the drag without granting automatic clipboard access. When an
application disables mouse reporting, Hive uses xterm selection for visible text.
Only gestures starting within the text grid qualify; scrollbar chrome and visible
input controls cannot grant clipboard access. Changing a mouse drag to a modified
selection also cancels its grant.

The explicit legacy selection-mode fallback retains its native marker, scrolling
exemption, browser Copy context menu, and preserved Copy text. Normal mobile
terminals use tmux selection.

Desktop tmux mouse drags retain copy on release. For both pointer types, Hive
starts the clipboard write during the release event and waits up to three
seconds for one OSC 52 response from that terminal. Browsers supporting deferred
ClipboardItem content can preserve the user gesture while tmux replies. If the
browser denies the write, a **Copy** action provides another gesture.
The deferred write follows [WebKit's clipboard gesture requirements](https://webkit.org/blog/10855/async-clipboard-api/).

Other workspace clipboard requests, including keyboard-driven copies inside a
remote application, offer **Copy** rather than overwriting the OS clipboard.
Remote programs cannot read the local clipboard. This is an intent boundary:
the workspace still controls the returned text, and an OSC 52 response within
the short selection window is not cryptographic proof of what was highlighted.
Parking or an inactive transition permanently cancels pending access, including
an inactive/active round trip before the next browser task. Returning to a pane
requires a new selection gesture or an explicit Copy action.

The change requires a web deployment and a refresh of existing terminal views;
no workspace restart or image rebuild is needed. Physical iOS Safari behavior
still requires device validation; Chromium touch emulation does not prove it.
