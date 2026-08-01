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

  async enqueue(snapshot, metadata = {}) {
    const next = { snapshot: structuredClone(snapshot), metadata };
    if (this.pending) next.metadata.analyticsEvents = [...(this.pending.metadata?.analyticsEvents || []), ...(metadata.analyticsEvents || [])];
    this.pending = next;
    await this.journal?.write(this.pending.snapshot);
    this.onStatus('queued');
    return this.drain();
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending) {
        const pending = this.pending;
        const { snapshot, metadata } = pending;
        this.pending = null;
        this.onStatus('saving');
        try {
          const result = await this.save(snapshot);
          this.onSaved(result, snapshot, metadata);
          if (!this.pending) {
            await this.journal?.clear();
            this.onStatus('saved');
          }
        } catch (error) {
          if (!this.pending) this.pending = pending;
          else this.pending.metadata.analyticsEvents = [...(metadata.analyticsEvents || []), ...(this.pending.metadata?.analyticsEvents || [])];
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

