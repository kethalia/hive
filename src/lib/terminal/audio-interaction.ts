import { TERMINAL_AUDIO_PRIME_EVENT } from "./events";

/** Enter may unlock speaker playback, but never authorizes microphone capture. */
export function primeTerminalAudio(element: HTMLElement | null) {
  const terminal = element?.closest<HTMLElement>('[data-terminal-surface="true"]');
  if (!terminal) return;
  terminal.dispatchEvent(new Event(TERMINAL_AUDIO_PRIME_EVENT, { bubbles: true }));
}
