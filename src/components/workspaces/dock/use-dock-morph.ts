import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export type DockPhase = "expanded" | "minimising" | "collapsed" | "expanding";
export function useDockMorph({
  surface,
  layout,
  content,
  expand,
  minimise,
  blocked = false,
}: {
  surface: RefObject<HTMLDivElement | null>;
  layout: RefObject<HTMLDivElement | null>;
  content: RefObject<HTMLDivElement | null>;
  expand: RefObject<HTMLButtonElement | null>;
  minimise: RefObject<HTMLButtonElement | null>;
  blocked?: boolean;
}) {
  const [phase, setPhase] = useState<DockPhase>("expanded");
  const current = useRef<DockPhase>("expanded"),
    running = useRef(false);
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const queued = useRef<{ open: boolean; focus: boolean } | null>(null);
  const animations = useRef<Animation[]>([]),
    ticket = useRef(0);
  const plan = useRef<{
    width: number;
    height: number;
    focus: boolean;
    returnFocus: boolean;
  } | null>(null);
  const finalFocus = useRef<{ open: boolean; focus: boolean } | null>(null);
  const change = useCallback(
    (open: boolean, focus = false) => {
      const navBusy =
        layout.current
          ?.querySelector('[aria-label="Workspace dock"]')
          ?.getAttribute("aria-busy") === "true";
      if (blockedRef.current || running.current || navBusy) {
        queued.current = { open, focus };
        return;
      }
      queued.current = null;
      if ((current.current === "expanded") === open) return;
      const box = surface.current?.getBoundingClientRect();
      if (!box) return;
      plan.current = {
        width: box.width,
        height: box.height,
        focus,
        returnFocus: !!layout.current?.contains(document.activeElement),
      };
      running.current = true;
      current.current = open ? "expanding" : "minimising";
      setPhase(current.current);
    },
    [layout, surface],
  );
  const latestChange = useRef(change);
  latestChange.current = change;
  useLayoutEffect(() => {
    const next = plan.current,
      shell = surface.current,
      row = layout.current;
    if (!next || !shell || !row) return;
    plan.current = null;
    const open = phase === "expanding",
      generation = ++ticket.current;
    if (!open && next.returnFocus && !blockedRef.current)
      expand.current?.focus({ preventScroll: true });
    const destination = row.getBoundingClientRect();
    const finish = () => {
      if (ticket.current !== generation) return;
      finalFocus.current = { open, focus: next.focus };
      current.current = open ? "expanded" : "collapsed";
      setPhase(current.current);
    };
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      finish();
      return;
    }
    const nextAnimations = [
      shell.animate(
        [
          {
            width: `${next.width}px`,
            height: `${next.height}px`,
            borderRadius: open ? "12px" : "9px",
          },
          {
            width: `${open ? destination.width + 2 : 48}px`,
            height: `${open ? destination.height + 2 : 48}px`,
            borderRadius: open ? "9px" : "12px",
          },
        ],
        {
          duration: open ? 380 : 340,
          delay: open ? 0 : 120,
          easing: "cubic-bezier(.55,0,.2,1)",
          fill: "both",
        },
      ),
    ];
    if (open) {
      if (expand.current)
        nextAnimations.push(
          expand.current.animate([{ opacity: 1 }, { opacity: 0 }], {
            duration: 100,
            fill: "forwards",
          }),
        );
      nextAnimations.push(
        row.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, delay: 380, fill: "both" }),
      );
      const caps = Array.from(
        content.current?.querySelectorAll<HTMLElement>(".hive-dock-button") ?? [],
      );
      const stagger = Math.min(60, 240 / Math.max(1, caps.length - 1));
      caps.forEach((cap, index) => {
        nextAnimations.push(
          cap.animate(
            [
              { opacity: 0, translate: "0 8px" },
              { opacity: 1, translate: "0 0" },
            ],
            {
              duration: 300,
              delay: 380 + index * stagger,
              easing: "cubic-bezier(.2,.8,.2,1)",
              fill: "both",
            },
          ),
        );
      });
    } else {
      nextAnimations.push(
        row.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: "forwards" }),
      );
      if (expand.current)
        nextAnimations.push(
          expand.current.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: 140,
            delay: 320,
            fill: "both",
          }),
        );
    }
    animations.current = nextAnimations;
    void Promise.all(nextAnimations.map((animation) => animation.finished))
      .then(finish)
      .catch(() => {});
  }, [phase, surface, layout, content, expand]);
  useLayoutEffect(() => {
    const focus = finalFocus.current;
    if (!focus || phase === "expanding" || phase === "minimising") return;
    finalFocus.current = null;
    for (const animation of animations.current) animation.cancel();
    animations.current = [];
    running.current = false;
    if (
      !blockedRef.current &&
      focus.open &&
      (document.activeElement === expand.current || focus.focus)
    ) {
      const target = focus.focus
        ? content.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        : minimise.current;
      target?.focus({ preventScroll: true });
    }
    const pending = queued.current;
    if (pending) latestChange.current(pending.open, pending.focus);
  }, [phase, content, expand, minimise]);
  useEffect(() => {
    const pending = queued.current;
    if (!blocked && pending && !running.current) latestChange.current(pending.open, pending.focus);
  }, [blocked]);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const pending = queued.current;
      if (pending && !running.current) latestChange.current(pending.open, pending.focus);
    });
    if (layout.current)
      observer.observe(layout.current, {
        subtree: true,
        attributes: true,
        attributeFilter: ["aria-busy"],
      });
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const finish = () => {
      if (media.matches) for (const animation of animations.current) animation.finish();
    };
    media.addEventListener("change", finish);
    return () => {
      ticket.current++;
      observer.disconnect();
      media.removeEventListener("change", finish);
      for (const animation of animations.current) animation.cancel();
    };
  }, [layout]);
  return {
    phase,
    change,
    busy: phase === "expanding" || phase === "minimising",
    expanded: phase === "expanded" || phase === "expanding",
  };
}
