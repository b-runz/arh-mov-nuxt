import { describe, test, expect } from "bun:test";
import {
  planMovieFetch,
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

  test("returns 'refresh' when the cached rating is '?', even though resolved and well within the TTL", () => {
    // A '?' rating means the last attempt to fetch a rating failed/was
    // rate-limited, not that the movie has no rating -- it should not be
    // frozen as a 7-day "success".
    const entry: CachedMovie = {
      imdb_link: "tt1234567",
      imdb_rating: "?",
      poster: "https://example.com/p.jpg",
      release_date: "2026-01-01T00:00:00.000Z",
      display_release_date: "01 January 2026",
      cachedAt: new Date(now.getTime() - 1000).toISOString(),
    };
    expect(planMovieFetch(entry, now)).toBe("refresh");
  });
});
