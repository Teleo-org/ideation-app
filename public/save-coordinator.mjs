export class SaveCoordinator {
  constructor({ save, journal, onStatus = () => {}, onSaved = () => {}, onConflict = () => {} }) {
    this.save = save;
    this.journal = journal;
    this.onStatus = onStatus;
    this.onSaved = onSaved;
    this.onConflict = onConflict;
    this.pending = null;
    this.running = false;
    this.retryTimer = null;
  }

  async enqueue(snapshot) {
    this.pending = structuredClone(snapshot);
    await this.journal?.write(this.pending);
    this.onStatus('queued');
    return this.drain();
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending) {
        const snapshot = this.pending;
        this.pending = null;
        this.onStatus('saving');
        try {
          const result = await this.save(snapshot);
          this.onSaved(result, snapshot);
          if (!this.pending) {
            await this.journal?.clear();
            this.onStatus('saved');
          }
        } catch (error) {
          if (!this.pending) this.pending = snapshot;
          if (error?.status === 409) {
            this.onStatus('conflict');
            this.onConflict(error, snapshot);
            return;
          }
          this.onStatus('offline');
          this.scheduleRetry();
          return;
        }
      }
    } finally {
      this.running = false;
    }
  }

  scheduleRetry(delay = 3000) {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.drain(), delay);
  }

  async flush() {
    clearTimeout(this.retryTimer);
    await this.drain();
  }
}

