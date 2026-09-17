// Runs the given task-producing functions with at most `limit` running at
// once, instead of firing all of them concurrently. A full-site build
// enriches every currently-listed movie (~150 of them), and each one fans
// out to several calls against undocumented/rate-limited third-party APIs
// (TMDB, IMDb's own GraphQL and suggest endpoints) -- launching all of them
// at once creates a burst far beyond what those APIs tolerate, causing a
// sustained rate-limit condition that fetchWithRetry's short backoff can't
// ride out, since the rest of the burst is still in flight by the time it
// retries. Throttling concurrency here prevents the burst in the first
// place, rather than just reacting to it after the fact.
export async function runWithConcurrencyLimit<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= tasks.length) return;
      results[index] = await tasks[index]!();
    }
  }

  const workerCount = Math.min(limit, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
