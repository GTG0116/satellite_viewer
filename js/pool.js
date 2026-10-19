/* Worker pool with a priority queue: the frame on screen decodes first, loop frames after. */

export class Pool {
  constructor(size) {
    this.size = size;
    this.workers = [];
    this.queue = [];      // {pri, seq, type, args, transfer, resolve, reject, id, signal}
    this.seq = 0;
    this.jobs = new Map();
    for (let i = 0; i < size; i++) this._spawn();
  }

  _spawn() {
    const w = new Worker(new URL('./decode/worker.js', import.meta.url), { type: 'module' });
    w.busy = 0;
    w.onmessage = (e) => {
      const { id, ok, result, error } = e.data;
      const j = this.jobs.get(id);
      this.jobs.delete(id);
      w.busy--;
      if (j) { if (ok) j.resolve(result); else j.reject(new Error(error)); }
      this._pump();
    };
    w.onerror = (e) => { console.error('worker error', e.message); };
    this.workers.push(w);
  }

  /** Run a task; lower pri runs first. signal aborts (queued: dropped; running: cancelled). */
  run(type, args, { pri = 5, transfer = [], signal } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('aborted')); return; }
      const job = { pri, seq: this.seq++, type, args, transfer, resolve, reject, id: `${this.seq}-${Math.random().toString(36).slice(2, 7)}`, signal };
      signal?.addEventListener('abort', () => {
        const i = this.queue.indexOf(job);
        if (i >= 0) { this.queue.splice(i, 1); reject(new Error('aborted')); }
        else if (job.worker) job.worker.postMessage({ id: job.id, type: 'cancel' });
      }, { once: true });
      this.queue.push(job);
      this._pump();
    });
  }

  _pump() {
    while (this.queue.length) {
      const w = this.workers.reduce((a, b) => (b.busy < a.busy ? b : a));
      // each worker takes up to 2 jobs: downloads overlap the previous job's decode
      if (w.busy >= 2) return;
      this.queue.sort((a, b) => a.pri - b.pri || a.seq - b.seq);
      const job = this.queue.shift();
      job.worker = w; w.busy++;
      this.jobs.set(job.id, job);
      w.postMessage({ id: job.id, type: job.type, args: job.args }, job.transfer);
    }
  }
}
