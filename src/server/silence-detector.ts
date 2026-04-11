const SILENCE_THRESHOLD_MS = 3000;

export class SilenceDetector {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private onSilence: (sessionId: string) => void;

  constructor(onSilence: (sessionId: string) => void) {
    this.onSilence = onSilence;
  }

  /** Call this every time a session produces output */
  recordActivity(sessionId: string): void {
    const existing = this.timers.get(sessionId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      this.onSilence(sessionId);
    }, SILENCE_THRESHOLD_MS);

    this.timers.set(sessionId, timer);
  }

  /** Clean up when a session is destroyed */
  remove(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(sessionId);
    }
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
