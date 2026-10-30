export interface DockPoint {
  x: number;
  y: number;
}
export interface DockPose {
  bounds: DOMRect;
  width: number;
  height: number;
  vertical: boolean;
  matrix: DOMMatrix;
  caps: Map<HTMLElement, DOMRect>;
}

export function captureDockPose(root: HTMLElement, surface: HTMLElement): DockPose {
  const style = getComputedStyle(surface);
  const scale = Number.parseFloat(style.scale) || 1;
  const matrix = new DOMMatrix(style.transform === "none" ? undefined : style.transform).scale(
    scale,
  );
  return {
    bounds: surface.getBoundingClientRect(),
    width: surface.offsetWidth,
    height: surface.offsetHeight,
    vertical: root.dataset.orientation === "vertical",
    matrix,
    caps: new Map(
      Array.from(
        root.querySelectorAll<HTMLElement>(
          ".hive-dock-button:not(.hive-dock-workspace), [data-dock-space], [data-dock-minimise], [data-dock-drag-handle]",
        ),
      ).map((node) => [node, node.getBoundingClientRect()]),
    ),
  };
}

/** Rotate the frame; counter-transform caps so their text stays upright along the same timeline. */
export function rotateDock(
  pose: DockPose,
  root: HTMLElement,
  surface: HTMLElement,
  duration: number,
) {
  if (root.dataset.phase !== "expanded") return [];
  const nextVertical = root.dataset.orientation === "vertical";
  const turn = pose.vertical !== nextVertical;
  const width = surface.offsetWidth,
    height = surface.offsetHeight;
  if (!turn && pose.matrix.isIdentity && pose.width === width && pose.height === height) return [];
  const start = pose.matrix
    .rotate(turn ? (nextVertical ? -90 : 90) : 0)
    .scale((turn ? pose.height : pose.width) / width, (turn ? pose.width : pose.height) / height);
  const inverse = start.inverse();
  const oldCentre = {
    x: pose.bounds.left + pose.bounds.width / 2,
    y: pose.bounds.top + pose.bounds.height / 2,
  };
  const bounds = surface.getBoundingClientRect();
  const centre = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
  // Finish all geometry reads before starting the parent transform.
  const caps = Array.from(pose.caps)
    .filter(([node]) => node.isConnected)
    .map(([node, old]) => {
      const rect = node.getBoundingClientRect();
      const css = getComputedStyle(node).transform;
      const end = new DOMMatrix(css === "none" ? undefined : css);
      const target = inverse.transformPoint(
        new DOMPoint(
          old.left + old.width / 2 - oldCentre.x,
          old.top + old.height / 2 - oldCentre.y,
        ),
      );
      const from = inverse.scale(
        old.width / Math.max(1, node.offsetWidth),
        old.height / Math.max(1, node.offsetHeight),
      );
      from.e = target.x - (rect.left + rect.width / 2 - centre.x - end.e);
      from.f = target.y - (rect.top + rect.height / 2 - centre.y - end.f);
      return {
        node,
        from,
        end,
        oldX: old.width / Math.max(1, node.offsetWidth),
        oldY: old.height / Math.max(1, node.offsetHeight),
      };
    });
  const options: KeyframeAnimationOptions = {
    duration,
    easing: "cubic-bezier(.4,0,.2,1)",
    fill: "both",
  };
  const animations = [
    surface.animate(
      [{ transform: start.toString() }, { transform: "matrix(1,0,0,1,0,0)" }],
      options,
    ),
  ];
  const angle = (Math.atan2(start.b, start.a) * 180) / Math.PI;
  const scaleX = Math.hypot(start.a, start.b),
    scaleY = (start.a * start.d - start.b * start.c) / scaleX;
  for (const cap of caps) {
    const frames: Keyframe[] = [];
    for (let i = 0; i <= 20; i++) {
      const p = i / 20,
        a = 1 - p;
      const frame = new DOMMatrix()
        .rotate(angle * a)
        .scale(1 + (scaleX - 1) * a, 1 + (scaleY - 1) * a);
      const glyph = new DOMMatrix([
        cap.oldX * a + cap.end.a * p,
        cap.end.b * p,
        cap.end.c * p,
        cap.oldY * a + cap.end.d * p,
        0,
        0,
      ]);
      const own = frame.inverse().multiply(glyph);
      own.e = cap.from.e * a + cap.end.e * p;
      own.f = cap.from.f * a + cap.end.f * p;
      frames.push({ offset: p, transform: own.toString() });
    }
    animations.push(cap.node.animate(frames, options));
  }
  for (const animation of animations) animation.pause();
  return animations;
}

/** Critically damped spring: preserve release velocity, then return without oscillation. */
export function dockSpring(from: DockPoint, to: DockPoint, velocity: DockPoint) {
  const speed = Math.hypot(velocity.x, velocity.y);
  const omega = 0.012 + 0.008 * Math.exp(-speed / 0.1);
  const ax = from.x - to.x,
    ay = from.y - to.y;
  const bx = velocity.x + omega * ax,
    by = velocity.y + omega * ay;
  return (time: number) => {
    const decay = Math.exp(-omega * time);
    return {
      x: to.x + (ax + bx * time) * decay,
      y: to.y + (ay + by * time) * decay,
      vx: (velocity.x - omega * bx * time) * decay,
      vy: (velocity.y - omega * by * time) * decay,
    };
  };
}
