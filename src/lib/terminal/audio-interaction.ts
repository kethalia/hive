import { TERMINAL_AUDIO_PRIME_EVENT } from "./events";

const interactions = new WeakMap<HTMLElement, number>();

/** Record the gesture before the optional audio bridge's chunk or effect loads. */
export function primeTerminalAudio(element: HTMLElement | null) {
  const terminal = element?.closest<HTMLElement>('[data-terminal-surface="true"]');
  if (!terminal) return;
  interactions.set(terminal, Date.now());
  terminal.dispatchEvent(new Event(TERMINAL_AUDIO_PRIME_EVENT, { bubbles: true }));
}

/** Each gesture permits one claim attempt, including a rejected or failed claim. */
export function consumeTerminalAudioInteraction(terminal: HTMLElement) {
  const at = interactions.get(terminal);
  interactions.delete(terminal);
  return at !== undefined && Date.now() - at < 15_000;
}
