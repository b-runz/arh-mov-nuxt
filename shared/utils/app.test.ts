import { describe, test, expect, mock } from "bun:test";
import { processData, type MovieEnrichmentDeps } from "./app";
import { CACHE_TTL_MS, type MovieCache } from "./movieCache";
import type { ImdbMatch } from "./imdbMatcher";

const NOW = new Date("2026-07-30T00:00:00.000Z");

function apiData(overrides: Partial<{ title: string; sanityImagePosterUrl: string; premiere: string }> = {}) {
  return {
    data: {
      movieQuery: {
        getCurrentMovies: [
          {
            title: overrides.title ?? "Test Movie",
            titleOriginal: "",
            mainVersionId: "1",
            premiere: overrides.premiere ?? "2026-01-01",
            productionYear: "2026",
            nationalities: ["Denmark"],
            lengthInMinutes: 100,
            sanityImagePosterUrl: overrides.sanityImagePosterUrl ?? "",
            shows: [],
          },
        ],
      },
    },
  };
}

function fakeMatch(overrides: Partial<ImdbMatch> = {}): ImdbMatch {
  return {
    imdbId: "tt1234567",
    confidence: "high",
    score: 90,
    margin: 30,
    agreement: true,
    candidateTitle: "Test Movie",
    candidateYear: "2026",
    source: "tmdb+imdb",
    ...overrides,
  };
}

describe("processData with a cache", () => {
  test("'resolve' plan: no cache entry runs the full pipeline and writes the result to the cache", async () => {
    const cache: MovieCache = {};
    const deps: MovieEnrichmentDeps = {
      resolveImdbId: mock(async () => fakeMatch()),
      getRating: mock(async () => ({ rating: "8.5", datePublished: "" })),
      getPosterUrl: mock(async () => "https://example.com/poster.jpg"),
    };

    const movies = await processData(apiData(), "tmdb-token", cache, NOW, deps);

    expect(deps.resolveImdbId).toHaveBeenCalledTimes(1);
    expect(movies[0]!.imdb_rating).toBe("8.5");
    expect(movies[0]!.imdb_link).toBe("tt1234567");
    expect(cache["test-movie"]).toMatchObject({ imdb_link: "tt1234567", imdb_rating: "8.5", cachedAt: NOW.toISOString() });
  });

  test("'resolve' plan: a low-confidence match is still cached as unresolved", async () => {
    const cache: MovieCache = {};
    const deps: MovieEnrichmentDeps = {
      resolveImdbId: mock(async () => fakeMatch({ confidence: "low" })),
      getRating: mock(async () => ({ rating: "?", datePublished: "" })),
      getPosterUrl: mock(async () => ""),
    };

    const movies = await processData(apiData(), "tmdb-token", cache, NOW, deps);

    expect(deps.getRating).not.toHaveBeenCalled();
    expect(movies[0]!.imdb_rating).toBe("?");
    expect(cache["test-movie"]).toMatchObject({ imdb_link: "", imdb_rating: "?", cachedAt: NOW.toISOString() });
  });

  test("'reuse' plan: a fresh cache entry is used as-is with no network calls", async () => {
    const cache: MovieCache = {
      "test-movie": {
        imdb_link: "tt9999999",
        imdb_rating: "9.0",
        poster: "https://example.com/cached.jpg",
        release_date: "2025-01-01T00:00:00.000Z",
        display_release_date: "01 January 2025",
        cachedAt: new Date(NOW.getTime() - 1000).toISOString(),
      },
    };
    const deps: MovieEnrichmentDeps = {
      resolveImdbId: mock(async () => fakeMatch()),
      getRating: mock(async () => ({ rating: "8.5", datePublished: "" })),
      getPosterUrl: mock(async () => "https://example.com/poster.jpg"),
    };

    const movies = await processData(apiData(), "tmdb-token", cache, NOW, deps);

    expect(deps.resolveImdbId).not.toHaveBeenCalled();
    expect(deps.getRating).not.toHaveBeenCalled();
    expect(deps.getPosterUrl).not.toHaveBeenCalled();
    expect(movies[0]!.imdb_rating).toBe("9.0");
    expect(movies[0]!.poster).toBe("https://example.com/cached.jpg");
  });

  test("'reuse' plan: fresher feed data (real premiere + real poster) overrides a stale cached 1900 release date and empty poster", async () => {
    const cache: MovieCache = {
      "test-movie": {
        imdb_link: "tt9999999",
        imdb_rating: "9.0",
        poster: "",
        release_date: "1900-01-01T00:00:00.000Z",
        display_release_date: "01 January 1900",
        cachedAt: new Date(NOW.getTime() - 1000).toISOString(),
      },
    };
    const deps: MovieEnrichmentDeps = {
      resolveImdbId: mock(async () => fakeMatch()),
      getRating: mock(async () => ({ rating: "8.5", datePublished: "" })),
      getPosterUrl: mock(async () => "https://example.com/poster.jpg"),
    };

    const movies = await processData(
      apiData({ premiere: "2026-05-01", sanityImagePosterUrl: "https://feed.example.com/fresh.jpg" }),
      "tmdb-token",
      cache,
      NOW,
      deps
    );

    // The cache is reused for id/rating, but the fresher feed data (a real
    // premiere date and a real poster) must win over the stale 1900
    // placeholder / empty poster frozen in the cache.
    expect(deps.resolveImdbId).not.toHaveBeenCalled();
    expect(movies[0]!.poster).toBe("https://feed.example.com/fresh.jpg");
    expect(movies[0]!.release_date).not.toBe("1900-01-01T00:00:00.000Z");
    expect(movies[0]!.display_release_date).not.toBe("01 January 1900");
    expect(new Date(movies[0]!.release_date).getUTCFullYear()).toBe(2026);
  });

  test("'refresh' plan: a stale cache entry keeps its id but refreshes rating/poster", async () => {
    const cache: MovieCache = {
      "test-movie": {
        imdb_link: "tt9999999",
        imdb_rating: "9.0",
        poster: "https://example.com/cached.jpg",
        release_date: "2025-01-01T00:00:00.000Z",
        display_release_date: "01 January 2025",
        cachedAt: new Date(NOW.getTime() - (CACHE_TTL_MS + 1000)).toISOString(),
      },
    };
    const deps: MovieEnrichmentDeps = {
      resolveImdbId: mock(async () => fakeMatch()),
      getRating: mock(async () => ({ rating: "9.2", datePublished: "" })),
      getPosterUrl: mock(async () => "https://example.com/new-poster.jpg"),
    };

    const movies = await processData(apiData(), "tmdb-token", cache, NOW, deps);

    expect(deps.resolveImdbId).not.toHaveBeenCalled();
    expect(deps.getRating).toHaveBeenCalledTimes(1);
    expect(movies[0]!.imdb_link).toBe("tt9999999");
    expect(movies[0]!.imdb_rating).toBe("9.2");
    expect(movies[0]!.poster).toBe("https://example.com/new-poster.jpg");
    expect(cache["test-movie"]!.cachedAt).toBe(NOW.toISOString());
  });

  test("'refresh' plan: falls back to the stale rating/poster when the refresh fails", async () => {
    const cache: MovieCache = {
      "test-movie": {
        imdb_link: "tt9999999",
        imdb_rating: "9.0",
        poster: "https://example.com/cached.jpg",
        release_date: "2025-01-01T00:00:00.000Z",
        display_release_date: "01 January 2025",
        cachedAt: new Date(NOW.getTime() - (CACHE_TTL_MS + 1000)).toISOString(),
      },
    };
    const deps: MovieEnrichmentDeps = {
      resolveImdbId: mock(async () => fakeMatch()),
      getRating: mock(async () => {
        throw new Error("network error");
      }),
      getPosterUrl: mock(async () => "https://example.com/new-poster.jpg"),
    };

    const movies = await processData(apiData(), "tmdb-token", cache, NOW, deps);

    expect(movies[0]!.imdb_rating).toBe("9.0");
    expect(movies[0]!.poster).toBe("https://example.com/cached.jpg");
    // The refresh failed, so cachedAt is NOT bumped -- the next build will retry it.
    expect(cache["test-movie"]!.cachedAt).toBe(new Date(NOW.getTime() - (CACHE_TTL_MS + 1000)).toISOString());
  });

  test("'unresolved' plan: a previously-unresolved movie is never retried", async () => {
    const cache: MovieCache = {
      "test-movie": {
        imdb_link: "",
        imdb_rating: "?",
        poster: "",
        release_date: "2025-01-01T00:00:00.000Z",
        display_release_date: "01 January 2025",
        cachedAt: new Date(NOW.getTime() - (CACHE_TTL_MS + 1000)).toISOString(),
      },
    };
    const deps: MovieEnrichmentDeps = {
      resolveImdbId: mock(async () => fakeMatch()),
      getRating: mock(async () => ({ rating: "8.5", datePublished: "" })),
      getPosterUrl: mock(async () => "https://example.com/poster.jpg"),
    };

    const movies = await processData(apiData(), "tmdb-token", cache, NOW, deps);

    expect(deps.resolveImdbId).not.toHaveBeenCalled();
    expect(movies[0]!.imdb_rating).toBe("?");
  });
});
