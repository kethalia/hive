import type { NotificationKind } from "./types";

export const SOUND_KEY = "hive-notification-sound-v1";
let context: AudioContext | null = null;
export async function unlockNotificationAudio() {
  context ??= new AudioContext();
  if (context.state === "suspended") await context.resume();
}

export async function playNotificationSound(kind: NotificationKind) {
  if (localStorage.getItem(SOUND_KEY) === "false") return;
  await unlockNotificationAudio();
  if (!context || context.state !== "running") return;
  // Short, soft square-wave chirps: a questioning rise, a resolved arpeggio,
  // and a lower warning pulse. Envelopes avoid sharp speaker clicks.
  const notes =
    kind === "ready"
      ? [523, 659, 784]
      : kind === "question" || kind === "approval"
        ? [740, 988, 740, 988]
        : [330, 262, 330];
  const audio = context;
  const start = audio.currentTime;
  notes.forEach((frequency, index) => {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    const at = start + index * 0.11;
    oscillator.type = "square";
    oscillator.frequency.setValueAtTime(frequency, at);
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.025, at + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.09);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(at);
    oscillator.stop(at + 0.1);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
  });
}
