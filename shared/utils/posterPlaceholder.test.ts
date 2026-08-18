import { describe, test, expect, mock, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeColorStats, isPlaceholderStats, getColorStatsFromImageBuffer, isPlaceholderPosterUrl } from "./posterPlaceholder";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "__fixtures__", name));

describe("computeColorStats", () => {
  test("a buffer of a single repeated RGB color has 1 unique color and dominantColorCount equal to the pixel count", () => {
    const pixels = Buffer.from([10, 20, 30, 10, 20, 30, 10, 20, 30]); // 3 pixels, 3 channels

    const stats = computeColorStats(pixels, 3);

    expect(stats.totalPixels).toBe(3);
    expect(stats.uniqueColors).toBe(1);
    expect(stats.dominantColorCount).toBe(3);
  });

  test("counts distinct RGB colors separately and tracks the largest group as dominantColorCount", () => {
    const pixels = Buffer.from([
      255, 0, 0, // red
      255, 0, 0, // red
      255, 0, 0, // red
      0, 255, 0, // green
    ]);

    const stats = computeColorStats(pixels, 3);

    expect(stats.totalPixels).toBe(4);
    expect(stats.uniqueColors).toBe(2);
    expect(stats.dominantColorCount).toBe(3);
  });

  test("ignores channels past the first 3 (e.g. alpha) when grouping colors", () => {
    const pixels = Buffer.from([
      10, 20, 30, 255,
      10, 20, 30, 0,
    ]);

    const stats = computeColorStats(pixels, 4);

    expect(stats.totalPixels).toBe(2);
    expect(stats.uniqueColors).toBe(1);
    expect(stats.dominantColorCount).toBe(2);
  });
});

describe("isPlaceholderStats", () => {
  test("flags stats matching kino.dk's flat 'no poster' card (measured: 508 unique colors, 77% one color)", () => {
    const stats = { totalPixels: 960_000, uniqueColors: 508, dominantColorCount: 739_413 };

    expect(isPlaceholderStats(stats)).toBe(true);
  });

  test("does not flag stats matching a real photographic poster (measured: 131k unique colors, 1.8% dominant)", () => {
    const stats = { totalPixels: 960_000, uniqueColors: 131_383, dominantColorCount: 17_280 };

    expect(isPlaceholderStats(stats)).toBe(false);
  });

  test("does not flag a poster with a large flat background but a rich color palette", () => {
    const stats = { totalPixels: 960_000, uniqueColors: 50_000, dominantColorCount: 600_000 };

    expect(isPlaceholderStats(stats)).toBe(false);
  });

  test("does not flag a poster with a limited palette but no single dominant color", () => {
    const stats = { totalPixels: 960_000, uniqueColors: 1_000, dominantColorCount: 100_000 };

    expect(isPlaceholderStats(stats)).toBe(false);
  });
});

describe("getColorStatsFromImageBuffer against real kino.dk images", () => {
  // Regression fixtures for the "Miroirs no. 3" bug: its sanityImagePosterUrl
  // pointed at kino.dk's placeholder card, but the old same-batch
  // duplicate-URL heuristic missed it because no other currently-listed movie
  // happened to share that exact URL at fetch time.
  test("classifies kino.dk's 'no poster' placeholder card as a placeholder", async () => {
    const stats = await getColorStatsFromImageBuffer(fixture("placeholder-poster.jpg"));

    expect(isPlaceholderStats(stats)).toBe(true);
  });

  test("does not classify a real movie poster as a placeholder", async () => {
    const stats = await getColorStatsFromImageBuffer(fixture("real-poster-1.jpg"));

    expect(isPlaceholderStats(stats)).toBe(false);
  });

  test("does not classify a second real movie poster as a placeholder", async () => {
    const stats = await getColorStatsFromImageBuffer(fixture("real-poster-2.jpg"));

    expect(isPlaceholderStats(stats)).toBe(false);
  });
});

describe("isPlaceholderPosterUrl", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("fetches a small jpg thumbnail (via Sanity's w/fm params) and classifies its content", async () => {
    const fetchMock = mock(async () => new Response(fixture("placeholder-poster.jpg")));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await isPlaceholderPosterUrl("https://cdn.sanity.io/images/proj/prod/abc-800x1200.jpg?auto=format");

    expect(result).toBe(true);
    const requestedUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(requestedUrl.searchParams.get("w")).toBe("100");
    expect(requestedUrl.searchParams.get("fm")).toBe("jpg");
  });

  test("returns false without throwing when the fetch fails (fail open: don't block a real poster on a network hiccup)", async () => {
    globalThis.fetch = mock(async () => new Response(null, { status: 500 })) as unknown as typeof fetch;

    const result = await isPlaceholderPosterUrl("https://cdn.sanity.io/images/proj/prod/abc-800x1200.jpg");

    expect(result).toBe(false);
  });
});
