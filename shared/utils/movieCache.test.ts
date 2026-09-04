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
      plot: "",
      language: "",
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
      plot: "",
      language: "",
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
      plot: "",
      language: "",
      cachedAt: new Date(now.getTime() - (CACHE_TTL_MS + 1000)).toISOString(),
    };
    expect(planMovieFetch(entry, now)).toBe("refresh");
  });

  test("returns 'rating-only' when the cached rating is '?', even though well within the TTL", () => {
    // The imdb id is already resolved -- a still-unrated movie can get a
    // real rating on IMDb any day, so it's checked every build regardless of
    // the TTL (unlike 'refresh', which waits for the TTL and also re-checks
    // the poster).
    const entry: CachedMovie = {
      imdb_link: "tt1234567",
      imdb_rating: "?",
      poster: "https://example.com/p.jpg",
      release_date: "2026-01-01T00:00:00.000Z",
      display_release_date: "01 January 2026",
      plot: "",
      language: "",
      cachedAt: new Date(now.getTime() - 1000).toISOString(),
    };
    expect(planMovieFetch(entry, now)).toBe("rating-only");
  });

  test("returns 'rating-only' when the cached rating is '?' and older than the TTL too", () => {
    // '?' takes priority over the TTL check entirely -- it's not a
    // TTL-driven decision at all.
    const entry: CachedMovie = {
      imdb_link: "tt1234567",
      imdb_rating: "?",
      poster: "https://example.com/p.jpg",
      release_date: "2026-01-01T00:00:00.000Z",
      display_release_date: "01 January 2026",
      plot: "",
      language: "",
      cachedAt: new Date(now.getTime() - (CACHE_TTL_MS + 1000)).toISOString(),
    };
    expect(planMovieFetch(entry, now)).toBe("rating-only");
  });
});
