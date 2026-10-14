/** Revoke a gesture when its surface is parked, even if it returns in one DOM batch. */
export function observeTerminalActivity(element: HTMLElement, cancel: () => void) {
  let disposed = false;
  let ancestors: Node[] = [];
  const path = () => {
    const nodes: Node[] = [];
    for (let node: Node | null = element; node; node = node.parentNode) nodes.push(node);
    return nodes;
  };
  const changed = (records: MutationRecord[]) => {
    if (disposed) return;
    if (
      !element.isConnected ||
      element.closest("[inert]") ||
      records.some((record) => {
        if (record.type === "attributes") {
          // oldValue catches add/remove before the observer runs, when the
          // current DOM already looks active again.
          return record.oldValue !== null || (record.target as Element).hasAttribute("inert");
        }
        return Array.from(record.removedNodes).some(
          (node) => ancestors.includes(node) || node.contains(element),
        );
      })
    )
      cancel();
    const next = path();
    if (next.length !== ancestors.length || next.some((node, index) => node !== ancestors[index])) {
      observer.disconnect();
      ancestors = next;
      for (const node of ancestors)
        observer.observe(node, {
          attributes: true,
          attributeFilter: ["inert"],
          attributeOldValue: true,
          childList: true,
        });
    }
  };
  const observer = new MutationObserver(changed);
  changed([]);
  return {
    // Check queued transitions before admitting an OSC 52 response in the same
    // task; the observer callback need not have run yet.
    flush() {
      changed(observer.takeRecords());
    },
    dispose() {
      disposed = true;
      observer.disconnect();
    },
  };
}
