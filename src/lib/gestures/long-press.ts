/**
 * Long-press detector with tap/drag disambiguation. Pure, framework-agnostic
 * timer + arming state so it can be unit-tested with fake timers and reused
 * across mobile touch surfaces such as sheets.
 *
 * Arming rule (see `src/lib/gestures/conventions.ts`):
 *  - Arm if pointer is held for `LONG_PRESS_MS` without exceeding
 *    `DRAG_LONG_PRESS_MOVE_PX` of travel.
 *  - Arm immediately if in-press travel exceeds `DRAG_LONG_PRESS_MOVE_PX`
 *    before the timer fires (intentional drag, no hold required).
 *  - Do NOT arm if pointer goes up before the timer fires and travel stays
 *    below the threshold (casual tap).
 */
import { DRAG_LONG_PRESS_MOVE_PX, LONG_PRESS_MS } from "./conventions";

export interface LongPressDetector {
  /** Begin a new press. Resets arming state and starts the hold timer. */
  start(): void;
  /** Report current pointer travel (px) since press start. */
  move(dist: number): void;
  /** End the press. Returns true if the press armed (long-press fired). */
  end(): boolean;
  /** Whether the press is currently armed. */
  readonly armed: boolean;
}

export interface LongPressOptions {
  onArm: () => void;
  longPressMs?: number;
  movePx?: number;
}

export function createLongPressDetector(opts: LongPressOptions): LongPressDetector {
  const longPressMs = opts.longPressMs ?? LONG_PRESS_MS;
  const movePx = opts.movePx ?? DRAG_LONG_PRESS_MOVE_PX;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let armed = false;
  let maxDist = 0;
  let active = false;

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function arm() {
    if (armed) return;
    armed = true;
    clearTimer();
    opts.onArm();
  }

  return {
    start() {
      active = true;
      armed = false;
      maxDist = 0;
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        if (!active) return;
        if (maxDist < movePx) arm();
      }, longPressMs);
    },
    move(dist: number) {
      if (!active) return;
      maxDist = Math.max(maxDist, dist);
      if (!armed && dist >= movePx) arm();
    },
    end() {
      clearTimer();
      active = false;
      const wasArmed = armed;
      armed = false;
      maxDist = 0;
      return wasArmed;
    },
    get armed() {
      return armed;
    },
  };
}
