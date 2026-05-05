import type { IndexJob, JobQueue } from "../contracts";

export class InMemoryJobQueue implements JobQueue {
  private jobs: IndexJob[] = [];
  private listeners = new Set<() => void>();

  enqueue(job: IndexJob): void {
    const last = this.jobs[this.jobs.length - 1];
    if (last && jobsEqual(last, job)) return; // coalesce consecutive dupes
    const wasEmpty = this.jobs.length === 0;
    this.jobs.push(job);
    if (wasEmpty) for (const l of this.listeners) l();
  }

  drain(): IndexJob[] {
    const out = this.jobs;
    this.jobs = [];
    return out;
  }

  size(): number {
    return this.jobs.length;
  }

  onArrival(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

function jobsEqual(a: IndexJob, b: IndexJob): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "rename" && b.kind === "rename") {
    return a.from === b.from && a.to === b.to;
  }
  if ((a.kind === "index" || a.kind === "delete") && a.kind === b.kind) {
    return a.path === (b as { path: string }).path;
  }
  return false;
}
