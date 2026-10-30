import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

type View = "home" | "workspaces" | "keyboard";
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Exit, resize the tray, then reveal the next row without accepting overlapping actions. */
export function useDockView() {
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
  const plan = useRef<{ width: number; reverse: boolean; animate: boolean; ticket: number } | null>(
    null,
  );

  const changeView = useCallback((next: View) => {
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
    const width = nav.getBoundingClientRect().width;
    const animate = !reducedMotion();
    setBusy(true);
    nav.focus({ preventScroll: true });
    const swap = () => {
      if (ticket !== generation.current) return;
      plan.current = { width, reverse: next === "home", animate, ticket };
      current.current = next;
      nav.style.width = `${width}px`;
      setView(next);
    };
    if (!animate) {
      swap();
      return;
    }
    const exit = panel.animate(
      [
        { opacity: 1, transform: "translateX(0)" },
        { opacity: 0, transform: `translateX(${next === "home" ? 10 : -10}px)` },
      ],
      { duration: 160, easing: "cubic-bezier(.55, 0, 1, .45)", fill: "forwards" },
    );
    animations.current = [exit];
    void exit.finished.then(swap).catch(() => {});
  }, []);

  useLayoutEffect(() => {
    const next = plan.current,
      nav = navRef.current,
      panel = panelRef.current;
    if (!next || !nav || !panel || current.current !== view) return;
    plan.current = null;
    nav.dataset.measuring = "true";
    nav.style.width = "max-content";
    const width = nav.getBoundingClientRect().width;
    delete nav.dataset.measuring;
    nav.style.width = `${width}px`;
    const finish = () => {
      if (generation.current !== next.ticket) return;
      nav.style.width = "";
      animations.current = [];
      running.current = false;
      focusPending.current = true;
      setBusy(false);
    };
    if (!next.animate || reducedMotion()) {
      finish();
      return;
    }
    const resize = nav.animate([{ width: `${next.width}px` }, { width: `${width}px` }], {
      duration: 560,
      easing: "cubic-bezier(.66, 0, .32, 1)",
    });
    const enter = panel.animate(
      [
        { opacity: 0, transform: `translateX(${next.reverse ? -12 : 12}px)` },
        { opacity: 1, transform: "translateX(0)" },
      ],
      { duration: 360, delay: 180, easing: "cubic-bezier(.5, 0, .2, 1)", fill: "backwards" },
    );
    animations.current = [resize, enter];
    void Promise.all([resize.finished, enter.finished])
      .then(finish)
      .catch(() => {});
  }, [view]);

  useLayoutEffect(() => {
    if (busy || !focusPending.current) return;
    focusPending.current = false;
    const selector =
      view === "home" ? `[data-dock-opener="${opener.current}"]` : "[data-dock-back]";
    navRef.current?.querySelector<HTMLButtonElement>(selector)?.focus({ preventScroll: true });
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
