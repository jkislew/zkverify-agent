// Bounded idempotency store: task IDs are idempotency keys. The platform may
// retry a delivery after a network failure; a retried task must return the
// first response instead of being decided (and proved) twice. Proof reuse
// across tasks is also a scored trap class, so never re-prove a seen task.
export class IdempotencyStore {
  constructor(maxEntries = 1000, ttlMs = 6 * 60 * 60 * 1000) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  get(id) {
    const hit = this.map.get(id);
    if (!hit) return null;
    if (Date.now() - hit.at > this.ttlMs) { this.map.delete(id); return null; }
    return hit.response;
  }

  set(id, response) {
    this.map.set(id, { at: Date.now(), response });
    while (this.map.size > this.maxEntries) {
      this.map.delete(this.map.keys().next().value);
    }
  }
}
