import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLongPressDetector } from "@/lib/gestures/long-press";
import { DRAG_LONG_PRESS_MOVE_PX, LONG_PRESS_MS } from "@/lib/gestures/conventions";

describe("createLongPressDetector", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not arm on a quick tap (release before LONG_PRESS_MS, no movement)", () => {
		const onArm = vi.fn();
		const d = createLongPressDetector({ onArm });
		d.start();
		vi.advanceTimersByTime(100);
		const wasArmed = d.end();
		expect(wasArmed).toBe(false);
		expect(d.armed).toBe(false);
		expect(onArm).not.toHaveBeenCalled();
	});

	it("arms at LONG_PRESS_MS hold without movement", () => {
		const onArm = vi.fn();
		const d = createLongPressDetector({ onArm });
		d.start();
		vi.advanceTimersByTime(LONG_PRESS_MS - 1);
		expect(d.armed).toBe(false);
		expect(onArm).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(d.armed).toBe(true);
		expect(onArm).toHaveBeenCalledTimes(1);
	});

	it("arms immediately when in-press movement crosses DRAG_LONG_PRESS_MOVE_PX before the timer fires", () => {
		const onArm = vi.fn();
		const d = createLongPressDetector({ onArm });
		d.start();
		vi.advanceTimersByTime(50);
		d.move(DRAG_LONG_PRESS_MOVE_PX - 0.01);
		expect(d.armed).toBe(false);
		expect(onArm).not.toHaveBeenCalled();
		d.move(DRAG_LONG_PRESS_MOVE_PX);
		expect(d.armed).toBe(true);
		expect(onArm).toHaveBeenCalledTimes(1);
	});

	it("does not arm if movement crosses threshold after early release", () => {
		const onArm = vi.fn();
		const d = createLongPressDetector({ onArm });
		d.start();
		vi.advanceTimersByTime(100);
		const wasArmed = d.end();
		// Movement after end() must be ignored (detector is idle).
		d.move(20);
		vi.advanceTimersByTime(LONG_PRESS_MS);
		expect(wasArmed).toBe(false);
		expect(onArm).not.toHaveBeenCalled();
	});

	it("does not arm when timer fires after movement crossed and disarmed via end()", () => {
		const onArm = vi.fn();
		const d = createLongPressDetector({ onArm });
		d.start();
		d.move(2);
		d.end();
		// Subsequent timer ticks should be cancelled — no extra arm.
		vi.advanceTimersByTime(LONG_PRESS_MS * 2);
		expect(onArm).not.toHaveBeenCalled();
	});

	it("does not arm when the press exceeds the move threshold and the timer would otherwise fire", () => {
		const onArm = vi.fn();
		const d = createLongPressDetector({ onArm });
		d.start();
		d.move(DRAG_LONG_PRESS_MOVE_PX); // arms immediately
		expect(onArm).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(LONG_PRESS_MS);
		// Timer should not double-arm.
		expect(onArm).toHaveBeenCalledTimes(1);
	});

	it("end() returns the armed state and resets internal state for the next press", () => {
		const onArm = vi.fn();
		const d = createLongPressDetector({ onArm });
		d.start();
		vi.advanceTimersByTime(LONG_PRESS_MS);
		expect(d.end()).toBe(true);
		expect(d.armed).toBe(false);

		// Next press: quick tap should not arm.
		d.start();
		vi.advanceTimersByTime(50);
		expect(d.end()).toBe(false);
		expect(onArm).toHaveBeenCalledTimes(1);
	});

	it("ignores stale timer when start() is called again before the previous timer fires", () => {
		const onArm = vi.fn();
		const d = createLongPressDetector({ onArm });
		d.start();
		vi.advanceTimersByTime(LONG_PRESS_MS - 10);
		d.start(); // resets timer
		vi.advanceTimersByTime(10);
		// Old timer would have fired here — but it was cleared.
		expect(onArm).not.toHaveBeenCalled();
		vi.advanceTimersByTime(LONG_PRESS_MS - 10);
		expect(onArm).toHaveBeenCalledTimes(1);
	});
});
