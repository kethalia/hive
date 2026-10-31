import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDockAxis } from "./dock-axis";

type View = "home" | "workspaces" | "keyboard";
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Exit, resize the tray, then reveal the next row without accepting overlapping actions. */
export function useDockView(preserveTerminalFocus = false) {
  const axis = useDockAxis();
  const previousAxis = useRef(axis);
  const [view, setView] = useState<View>("home");
  const [busy, setBusy] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const current = useRef<View>("home");
  const opener = useRef<View>("workspaces");
  const running = useRef(false);
  const queued = useRef<View | null>(null);
  const animations = useRef<Animation[]>([]);
  const generation = useRef(0);
  const focusPending = useRef(false);
  const plan = useRef<{
    bounds: DOMRect;
    reverse: boolean;
    animate: boolean;
    ticket: number;
  } | null>(null);

  const changeView = useCallback(
    (next: View) => {
      if (running.current) {
        queued.current = next;
        return;
      }
      if (next === current.current) return;
      const nav = navRef.current,
        panel = panelRef.current;
      if (!nav || !panel) return;
      if (next !== "home") opener.current = next;
      running.current = true;
      const ticket = ++generation.current;
      const bounds = nav.getBoundingClientRect();
      const animate = !reducedMotion();
      setBusy(true);
      const terminalFocused = document.activeElement?.classList.contains("xterm-helper-textarea");
      if (!preserveTerminalFocus || !terminalFocused) nav.focus({ preventScroll: true });
      const swap = () => {
        if (ticket !== generation.current) return;
        plan.current = { bounds, reverse: next === "home", animate, ticket };
        current.current = next;
        nav.style[axis.size] = `${bounds[axis.size]}px`;
        setView(next);
      };
      if (!animate) {
        swap();
        return;
      }
      const exit = panel.animate(
        [
          { opacity: 1, transform: `${axis.translate}(0)` },
          { opacity: 0, transform: `${axis.translate}(${next === "home" ? 10 : -10}px)` },
        ],
        { duration: 160, easing: "cubic-bezier(.55, 0, 1, .45)", fill: "forwards" },
      );
      animations.current = [exit];
      void exit.finished.then(swap).catch(() => {});
    },
    [axis, preserveTerminalFocus],
  );

  useLayoutEffect(() => {
    const next = plan.current,
      nav = navRef.current,
      panel = panelRef.current;
    if (!next || !nav || !panel || current.current !== view) return;
    plan.current = null;
    nav.dataset.measuring = "true";
    nav.style[axis.size] = "max-content";
    const size = nav.getBoundingClientRect()[axis.size];
    delete nav.dataset.measuring;
    nav.style[axis.size] = `${size}px`;
    const finish = () => {
      if (generation.current !== next.ticket) return;
      nav.style.width = "";
      nav.style.height = "";
      animations.current = [];
      running.current = false;
      focusPending.current = true;
      setBusy(false);
    };
    if (!next.animate || reducedMotion()) {
      finish();
      return;
    }
    const resize = nav.animate(
      [{ [axis.size]: `${next.bounds[axis.size]}px` }, { [axis.size]: `${size}px` }],
      {
        duration: 560,
        easing: "cubic-bezier(.66, 0, .32, 1)",
      },
    );
    const enter = panel.animate(
      [
        { opacity: 0, transform: `${axis.translate}(${next.reverse ? -12 : 12}px)` },
        { opacity: 1, transform: `${axis.translate}(0)` },
      ],
      { duration: 360, delay: 180, easing: "cubic-bezier(.5, 0, .2, 1)", fill: "backwards" },
    );
    animations.current = [resize, enter];
    void Promise.all([resize.finished, enter.finished])
      .then(finish)
      .catch(() => {});
  }, [view, axis]);

  useLayoutEffect(() => {
    if (previousAxis.current === axis) return;
    previousAxis.current = axis;
    for (const animation of animations.current) animation.finish();
    if (navRef.current) {
      navRef.current.style.width = "";
      navRef.current.style.height = "";
    }
  }, [axis]);

  useLayoutEffect(() => {
    if (busy || !focusPending.current) return;
    focusPending.current = false;
    const selector =
      view === "home" ? `[data-dock-opener="${opener.current}"]` : "[data-dock-back]";
    // A launcher may have taken focus while the row was animating.
    if (navRef.current?.contains(document.activeElement))
      navRef.current.querySelector<HTMLButtonElement>(selector)?.focus({ preventScroll: true });
    const next = queued.current;
    queued.current = null;
    if (next && next !== view) changeView(next);
  }, [busy, view, changeView]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finish = () => {
      if (media.matches) for (const animation of animations.current) animation.finish();
    };
    media.addEventListener("change", finish);
    return () => {
      generation.current++;
      for (const animation of animations.current) animation.cancel();
      media.removeEventListener("change", finish);
    };
  }, []);

  return { view, busy, navRef, panelRef, changeView };
}
