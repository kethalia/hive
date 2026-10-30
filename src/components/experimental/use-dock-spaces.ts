import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

interface Snapshot {
  width: number;
  positions: Map<string, number>;
}

/** Coordinate cap presence, the surrounding tray, and the surviving caps' positions. */
export function useDockSpaces({
  ids,
  activeId,
  visible,
  viewBusy,
  navRef,
  onCreate,
  onRemove,
}: {
  ids: string[];
  activeId: string;
  visible: boolean;
  viewBusy: boolean;
  navRef: RefObject<HTMLElement | null>;
  onCreate: () => void;
  onRemove?: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const alive = useRef(true);
  const animations = useRef<Animation[]>([]);
  const snapshot = useRef<Snapshot | null>(null);
  const signature = JSON.stringify(ids);
  const latest = useRef({ signature, onCreate, onRemove });
  latest.current = { signature, onCreate, onRemove };
  const previous = useRef(signature);
  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function capture() {
    const nav = navRef.current;
    if (!nav) return null;
    const bounds = nav.getBoundingClientRect();
    return {
      width: bounds.width,
      positions: new Map(
        Array.from(nav.querySelectorAll<HTMLElement>("[data-dock-space]")).map((node) => [
          node.dataset.dockSpace ?? "",
          node.getBoundingClientRect().left - bounds.left,
        ]),
      ),
    };
  }

  function release() {
    if (!alive.current) return;
    for (const animation of animations.current) animation.cancel();
    animations.current = [];
    if (navRef.current) navRef.current.style.width = "";
    running.current = false;
    setBusy(false);
  }

  function ensureAccepted(before: string) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // A controlled update may commit after the animation's completion microtask.
        // Keep its geometry snapshot so that a late commit still animates the row.
        if (alive.current && latest.current.signature === before) release();
      });
    });
  }

  function create() {
    if (running.current || viewBusy) return;
    snapshot.current = capture();
    running.current = true;
    setBusy(true);
    const before = latest.current.signature;
    latest.current.onCreate();
    ensureAccepted(before);
  }

  function remove(id: string) {
    if (running.current || viewBusy || !latest.current.onRemove) return;
    snapshot.current = capture();
    running.current = true;
    setBusy(true);
    navRef.current?.focus({ preventScroll: true });
    const node = Array.from(
      navRef.current?.querySelectorAll<HTMLElement>("[data-dock-space]") ?? [],
    ).find((item) => item.dataset.dockSpace === id);
    const commit = () => {
      if (!alive.current) return;
      const before = latest.current.signature;
      latest.current.onRemove?.(id);
      ensureAccepted(before);
    };
    if (reduced() || !node) {
      commit();
      return;
    }
    const exit = node.animate(
      [
        { opacity: 1, transform: "translateY(0) scale(1)" },
        { opacity: 0, transform: "translateY(-12px) scale(.82)" },
      ],
      { duration: 180, easing: "ease-in", fill: "forwards" },
    );
    animations.current = [exit];
    void exit.finished.then(commit).catch(() => {});
  }

  useLayoutEffect(() => {
    if (previous.current === signature) return;
    previous.current = signature;
    const before = snapshot.current,
      nav = navRef.current;
    snapshot.current = null;
    if (!before || !nav || !visible || viewBusy || reduced()) {
      release();
      return;
    }
    running.current = true;
    setBusy(true);
    nav.dataset.measuring = "true";
    nav.style.width = "max-content";
    const bounds = nav.getBoundingClientRect();
    nav.style.width = `${bounds.width}px`;
    const options = nav.querySelector<HTMLElement>(".hive-dock-options");
    const frame = nav.querySelector<HTMLElement>(".hive-dock-scroll-frame");
    // If the final row fits, keep its old arrows hidden throughout playback.
    // Removing them only after playback would shift every cap by an arrow's width.
    if (!options || !frame || options.scrollWidth > frame.clientWidth + 1)
      delete nav.dataset.measuring;
    const selected = Array.from(nav.querySelectorAll<HTMLElement>("[data-dock-space]")).find(
      (node) => node.dataset.dockSpace === activeId,
    );
    if (options && selected) {
      const item = selected.getBoundingClientRect(),
        area = options.getBoundingClientRect();
      if (item.left < area.left + 10) options.scrollLeft -= area.left + 10 - item.left;
      else if (item.right > area.right - 12) options.scrollLeft += item.right - area.right + 12;
    }
    const adding = ids.some((id) => !before.positions.has(id));
    const resizeDuration = adding ? 280 : 440;
    const entryDelay = Math.abs(bounds.width - before.width) > 0.5 ? resizeDuration : 0;
    // Read every destination before animating width: a centered tray moves as it
    // resizes, so measuring against the final bounds after playback starts adds
    // half the width change to each cap's movement.
    const caps = Array.from(nav.querySelectorAll<HTMLElement>("[data-dock-space]")).map((node) => {
      const old = before.positions.get(node.dataset.dockSpace ?? "");
      return {
        node,
        delta:
          old === undefined ? undefined : old - (node.getBoundingClientRect().left - bounds.left),
      };
    });
    const next: Animation[] = [
      nav.animate([{ width: `${before.width}px` }, { width: `${bounds.width}px` }], {
        duration: resizeDuration,
        easing: "cubic-bezier(.25, .8, .25, 1)",
      }),
    ];
    for (const { node, delta } of caps) {
      if (delta === undefined)
        next.push(
          node.animate(
            [
              { opacity: 0, transform: "translateY(10px) scale(.8)" },
              { opacity: 1, transform: "translateY(0) scale(1)" },
            ],
            {
              duration: 260,
              delay: entryDelay,
              easing: "cubic-bezier(.2, .8, .2, 1)",
              fill: "backwards",
            },
          ),
        );
      else {
        if (Math.abs(delta) > 0.5)
          next.push(
            node.animate(
              [{ transform: `translateX(${delta}px)` }, { transform: "translateX(0)" }],
              { duration: resizeDuration, easing: "cubic-bezier(.25, .8, .25, 1)" },
            ),
          );
      }
    }
    animations.current = next;
    void Promise.all(next.map((animation) => animation.finished))
      .then(release)
      .catch(() => {});
  });

  useLayoutEffect(() => {
    // The scroll area measures the settled layout in this same React commit.
    // Keep the width-measurement override until that commit, including async callbacks.
    if (!busy && !running.current && navRef.current) delete navRef.current.dataset.measuring;
  }, [busy, navRef]);

  useEffect(() => {
    alive.current = true;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finish = () => {
      if (media.matches) for (const animation of animations.current) animation.finish();
    };
    media.addEventListener("change", finish);
    return () => {
      alive.current = false;
      for (const animation of animations.current) animation.cancel();
      media.removeEventListener("change", finish);
    };
  }, []);

  return { busy, create, remove };
}
