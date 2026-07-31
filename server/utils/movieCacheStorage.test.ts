import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMovieCache, saveMovieCache } from "./movieCacheStorage";
import type { CachedMovie } from "~/shared/utils/movieCache";

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
