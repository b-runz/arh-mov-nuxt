import { describe, test, expect, afterEach, mock } from "bun:test";
import { fetchWithRetry, backoffDelayMs } from "./fetchRetry";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("fetchWithRetry", () => {
  test("returns the response immediately on success, without retrying", async () => {
    const calls: string[] = [];
    globalThis.fetch = mock(async (url: string) => {
      calls.push(url);
      return jsonResponse(200, { ok: true });
    }) as typeof fetch;

    const res = await fetchWithRetry("https://example.com/a", {}, { baseDelayMs: 1 });

    expect(res.status).toBe(200);
    expect(calls).toEqual(["https://example.com/a"]);
  });

  test("retries a retryable status code (429) and returns the eventual success", async () => {
    let attempts = 0;
    globalThis.fetch = mock(async () => {
      attempts++;
      return attempts < 2 ? jsonResponse(429) : jsonResponse(200, { ok: true });
    }) as typeof fetch;

    const res = await fetchWithRetry("https://example.com/a", {}, { baseDelayMs: 1 });

    expect(res.status).toBe(200);
    expect(attempts).toBe(2);
  });

  test("does not retry a non-retryable status code (404)", async () => {
    let attempts = 0;
    globalThis.fetch = mock(async () => {
      attempts++;
      return jsonResponse(404);
    }) as typeof fetch;

    const res = await fetchWithRetry("https://example.com/a", {}, { baseDelayMs: 1 });

    expect(res.status).toBe(404);
    expect(attempts).toBe(1);
  });

  test("gives up and returns the last failed response after exhausting retries", async () => {
    let attempts = 0;
    globalThis.fetch = mock(async () => {
      attempts++;
      return jsonResponse(503);
    }) as typeof fetch;

    const res = await fetchWithRetry("https://example.com/a", {}, { retries: 2, baseDelayMs: 1 });

    expect(res.status).toBe(503);
    expect(attempts).toBe(3); // initial attempt + 2 retries
  });

  test("retries a thrown network error and returns the eventual success", async () => {
    let attempts = 0;
    globalThis.fetch = mock(async () => {
      attempts++;
      if (attempts < 2) throw new Error("network down");
      return jsonResponse(200, { ok: true });
    }) as typeof fetch;

    const res = await fetchWithRetry("https://example.com/a", {}, { baseDelayMs: 1 });

    expect(res.status).toBe(200);
    expect(attempts).toBe(2);
  });

  test("rethrows the last network error after exhausting retries", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("network down");
    }) as typeof fetch;

    await expect(fetchWithRetry("https://example.com/a", {}, { retries: 1, baseDelayMs: 1 })).rejects.toThrow("network down");
  });
});

describe("backoffDelayMs", () => {
  test("grows exponentially with the attempt number", () => {
    // Jitter is +/-25%, so compare midpoints rather than exact values.
    expect(backoffDelayMs(0, 100)).toBeGreaterThanOrEqual(75);
    expect(backoffDelayMs(0, 100)).toBeLessThanOrEqual(125);
    expect(backoffDelayMs(2, 100)).toBeGreaterThanOrEqual(300);
    expect(backoffDelayMs(2, 100)).toBeLessThanOrEqual(500);
  });
});
