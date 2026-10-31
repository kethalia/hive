"use client";

import { useEffect, useState } from "react";

/** Include pane-owned dialogs as well as the global launcher/help overlays. */
const MODAL_SELECTOR = '[aria-modal="true"], [role="dialog"], [role="alertdialog"]';

export function useModalOpen() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const update = () => {
      const modal = Array.from(document.querySelectorAll(MODAL_SELECTOR)).some(
        (node) => !node.closest("[hidden], [inert], [data-ending-style]"),
      );
      setOpen((previous) => (previous === modal ? previous : modal));
    };
    const containsModal = (node: Node) =>
      node instanceof Element &&
      (node.matches(MODAL_SELECTOR) || node.querySelector(MODAL_SELECTOR));
    const observer = new MutationObserver((records) => {
      // Terminal output mutates constantly. Only inspect the document for modal changes.
      if (
        records.some((record) =>
          record.type === "attributes"
            ? record.attributeName === "aria-modal" ||
              record.attributeName === "role" ||
              containsModal(record.target)
            : [...record.addedNodes, ...record.removedNodes].some(containsModal),
        )
      )
        update();
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-modal", "role", "hidden", "inert", "data-ending-style"],
    });
    update();
    return () => observer.disconnect();
  }, []);
  return open;
}
