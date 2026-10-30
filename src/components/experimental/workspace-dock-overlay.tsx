"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import "./workspace-dock-overlay.css";

/** Overlay placement and visibility stay separate from the dock's navigation state. */
export function WorkspaceDockOverlay({
  children,
  blocked = false,
}: {
  children: ReactNode;
  /** Keep the dock available while a launcher, dialog, or native picker is in use. */
  blocked?: boolean;
}) {
  const [visible, setVisible] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const focusOnShow = useRef(false);
  const id = useId();

  function hide() {
    if (content.current?.contains(document.activeElement)) toggle.current?.focus();
    setHovered(false);
    setFocused(false);
    setVisible(false);
  }

  useEffect(() => {
    if (!visible || hovered || focused || blocked) return;
    const timer = window.setTimeout(() => {
      if (!content.current?.contains(document.activeElement)) setVisible(false);
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [visible, hovered, focused, blocked]);

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (
        blocked ||
        event.repeat ||
        event.isComposing ||
        !event.altKey ||
        !event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.code !== "KeyD"
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (visible) hide();
      else {
        focusOnShow.current = true;
        setVisible(true);
      }
    }
    window.addEventListener("keydown", shortcut, true);
    return () => window.removeEventListener("keydown", shortcut, true);
  });

  useLayoutEffect(() => {
    if (!visible || !focusOnShow.current) return;
    focusOnShow.current = false;
    content.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [visible]);

  return (
    <div className="hive-dock-overlay" data-dock-visible={visible}>
      <Button
        ref={toggle}
        type="button"
        variant="ghost"
        className="hive-dock-toggle"
        aria-label={visible ? "Hide dock" : "Show dock"}
        aria-expanded={visible}
        aria-controls={id}
        aria-describedby={`${id}-help`}
        aria-keyshortcuts="Alt+Shift+D"
        title={`${visible ? "Hide" : "Show"} dock (Alt+Shift+D)`}
        onClick={() => {
          if (visible) hide();
          else setVisible(true);
        }}
      >
        {visible ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
        <span className="sr-only">Dock</span>
      </Button>
      <div
        ref={content}
        id={id}
        className="hive-dock-overlay-content"
        inert={!visible}
        aria-hidden={!visible}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse" || event.pointerType === "pen") setHovered(true);
        }}
        onPointerLeave={() => setHovered(false)}
        onPointerCancel={() => setHovered(false)}
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
        }}
      >
        {children}
      </div>
      <span id={`${id}-help`} className="sr-only">
        The dock hides after 2.5 seconds away. Show it, then press Tab to reach its controls.
        Alt+Shift+D shows the dock and focuses its controls, or hides it and returns focus here.
      </span>
    </div>
  );
}
