type ViewportListener = (orientationChanged: boolean) => void;

const listeners = new Set<ViewportListener>();
let disconnect: (() => void) | undefined;

/** Share viewport/lifecycle events between the shell measurements and keyboard consumers. */
export function subscribeViewportEvents(listener: ViewportListener): () => void {
  listeners.add(listener);
  if (!disconnect) {
    const viewport = window.visualViewport;
    let pending: number[] = [];
    const cancelPending = () => {
      for (const timer of pending) window.clearTimeout(timer);
      pending = [];
    };
    const emit = (orientationChanged = false) => {
      for (const callback of listeners) callback(orientationChanged);
    };
    const update = () => emit();
    const resume = () => {
      cancelPending();
      if (document.visibilityState === "hidden") return;
      update();
      // WebKit can restore its viewport after pageshow/focus without another resize.
      // Bounded rereads also cover the keyboard dismissal animation on app return.
      pending = [0, 100, 300, 1000].map((delay) => window.setTimeout(update, delay));
    };
    const orientation = () => {
      emit(true);
      resume();
    };
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", orientation);
    window.addEventListener("pageshow", resume);
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    disconnect = () => {
      cancelPending();
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", orientation);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
    };
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      disconnect?.();
      disconnect = undefined;
    }
  };
}
