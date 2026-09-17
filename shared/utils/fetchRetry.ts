// Wraps fetch with exponential-backoff retry for transient failures (network
// errors, rate limiting, and 5xx server errors) -- not for deterministic
// client errors (404, 401, etc), which retrying can't fix. A full-site
// prerender (see nuxt.config.ts's crawlLinks) fires hundreds of requests
// against undocumented/rate-limited third-party APIs (TMDB, IMDb's own
// GraphQL and suggest endpoints) in a short window; without this, a single
// transient hiccup silently and permanently bakes a missing poster/rating/
// match into the static build until the next rebuild -- every call site
// already treats a failure as "no data available" by design rather than
// failing the whole build, so a spurious one-off failure is strictly worse
// than a brief retry.

export const DEFAULT_RETRY_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  retryStatusCodes?: Set<number>;
}

// Exponential growth with +/-25% jitter, so many concurrent requests hitting
// the same rate limit don't all retry in lockstep at the exact same moment.
export function backoffDelayMs(attempt: number, baseDelayMs = 300): number {
  return baseDelayMs * 2 ** attempt * (0.75 + Math.random() * 0.5);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(input: string, init: RequestInit = {}, options: RetryOptions = {}): Promise<Response> {
  const retries = options.retries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 300;
  const retryStatusCodes = options.retryStatusCodes ?? DEFAULT_RETRY_STATUS_CODES;

  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(input, init);
    } catch (error) {
      if (attempt >= retries) throw error;
      await sleep(backoffDelayMs(attempt, baseDelayMs));
      continue;
    }
    if (response.ok || attempt >= retries || !retryStatusCodes.has(response.status)) return response;
    await sleep(backoffDelayMs(attempt, baseDelayMs));
  }
}
