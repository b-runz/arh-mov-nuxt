import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planMovieFetch,
  loadMovieCache,
  saveMovieCache,
  CACHE_TTL_MS,
  type CachedMovie,
} from "./movieCache";

describe("planMovieFetch", () => {
  const now = new Date("2026-07-30T00:00:00.000Z");

  test("returns 'resolve' when there is no cache entry", () => {
    expect(planMovieFetch(undefined, now)).toBe("resolve");
  });

  test("returns 'unresolved' when the cached entry has no imdb_link", () => {
    const entry: CachedMovie = {
      imdb_link: "",
      imdb_rating: "?",
      poster: "",
      release_date: "",
      display_release_date: "",
      cachedAt: now.toISOString(),
    };
    expect(planMovieFetch(entry, now)).toBe("unresolved");
  });

  test("returns 'reuse' when the cached entry is resolved and within the TTL", () => {
    const entry: CachedMovie = {
      imdb_link: "tt1234567",
      imdb_rating: "7.5",
      poster: "https://example.com/p.jpg",
      release_date: "2026-01-01T00:00:00.000Z",
      display_release_date: "01 January 2026",
      cachedAt: new Date(now.getTime() - (CACHE_TTL_MS - 1000)).toISOString(),
    };
    expect(planMovieFetch(entry, now)).toBe("reuse");
  });

  test("returns 'refresh' when the cached entry is resolved but older than the TTL", () => {
    const entry: CachedMovie = {
      imdb_link: "tt1234567",
      imdb_rating: "7.5",
      poster: "https://example.com/p.jpg",
      release_date: "2026-01-01T00:00:00.000Z",
      display_release_date: "01 January 2026",
      cachedAt: new Date(now.getTime() - (CACHE_TTL_MS + 1000)).toISOString(),
    };
    expect(planMovieFetch(entry, now)).toBe("refresh");
  });
});

describe("loadMovieCache / saveMovieCache", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("loadMovieCache returns {} when the file doesn't exist", async () => {
    dir = mkdtempSync(join(tmpdir(), "movie-cache-test-"));
    const cache = await loadMovieCache(join(dir, "missing.json"));
    expect(cache).toEqual({});
  });

  test("loadMovieCache returns {} when the file has invalid JSON", async () => {
    dir = mkdtempSync(join(tmpdir(), "movie-cache-test-"));
    const path = join(dir, "corrupt.json");
    await Bun.write(path, "{ not valid json");
    const cache = await loadMovieCache(path);
    expect(cache).toEqual({});
  });

  test("saveMovieCache then loadMovieCache round-trips the data, creating missing directories", async () => {
    dir = mkdtempSync(join(tmpdir(), "movie-cache-test-"));
    const path = join(dir, "nested", "movie-cache.json");
    const data: Record<string, CachedMovie> = {
      "some-movie": {
        imdb_link: "tt1234567",
        imdb_rating: "8.1",
        poster: "https://example.com/p.jpg",
        release_date: "2026-01-01T00:00:00.000Z",
        display_release_date: "01 January 2026",
        cachedAt: "2026-07-30T00:00:00.000Z",
      },
    };

    await saveMovieCache(path, data);
    const loaded = await loadMovieCache(path);

    expect(loaded).toEqual(data);
  });
});
