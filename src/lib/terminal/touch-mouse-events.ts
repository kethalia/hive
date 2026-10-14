const touchMouseEvents = new WeakSet<Event>();

export const isTerminalTouchMouseEvent = (event: Event) => touchMouseEvents.has(event);

export function markTerminalTouchMouseEvent(event: MouseEvent): void {
  touchMouseEvents.add(event);
}
