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
      getMovieMetadata: mock(async () => ({ poster: "https://example.com/poster.jpg", plot: "A test plot.", language: "da" })),
      isPlaceholderPosterUrl: mock(async () => false),
    };

    const movies = await processData(apiData(), "tmdb-token", cache, NOW, deps);

    expect(deps.resolveImdbId).toHaveBeenCalledTimes(1);
    expect(movies[0]!.imdb_rating).toBe("8.5");
    expect(movies[0]!.imdb_link).toBe("tt1234567");
    expect(movies[0]!.plot).toBe("A test plot.");
    expect(movies[0]!.language).toBe("da");
    expect(cache["test-movie"]).toMatchObject({
      imdb_link: "tt1234567",
      imdb_rating: "8.5",
      plot: "A test plot.",
      language: "da",
      cachedAt: NOW.toISOString(),
    });
  });

  test("'resolve' plan: a low-confidence match is still cached as unresolved", async () => {
    const cache: MovieCache = {};
    const deps: MovieEnrichmentDeps = {
      resolveImdbId: mock(async () => fakeMatch({ confidence: "low" })),
      getRating: mock(async () => ({ rating: "?", datePublished: "" })),
      getMovieMetadata: mock(async () => ({ poster: "", plot: "", language: "" })),
      isPlaceholderPosterUrl: mock(async () => false),
    };

    const movies = await processData(apiData(), "tmdb-token", cache, NOW, deps);

    expect(deps.getRating).not.toHaveBeenCalled();
    expect(movies[0]!.imdb_rating).toBe("?");
    expect(movies[0]!.plot).toBe("");
    expect(movies[0]!.language).toBe("");
    expect(cache["test-movie"]).toMatchObject({ imdb_link: "", imdb_rating: "?", cachedAt: NOW.toISOString() });
  });

  test("'resolve' plan: a poster url flagged as a placeholder (e.g. kino.dk's 'no poster' card) is not kept -- falls through to TMDB instead", async () => {
    const cache: MovieCache = {};
    const deps: MovieEnrichmentDeps = {
      resolveImdbId: mock(async () => fakeMatch()),
      getRating: mock(async () => ({ rating: "8.5", datePublished: "" })),
      getMovieMetadata: mock(async () => ({ poster: "https://image.tmdb.org/t/p/w500/real.jpg", plot: "A test plot.", language: "en" })),
      isPlaceholderPosterUrl: mock(async (url: string) => url === "https://cdn.sanity.io/placeholder.jpg"),
    };

    const movies = await processData(
      apiData({ sanityImagePosterUrl: "https://cdn.sanity.io/placeholder.jpg" }),
      "tmdb-token",
      cache,
      NOW,
      deps
    );

    expect(movies[0]!.poster).toBe("https://image.tmdb.org/t/p/w500/real.jpg");
  });

  test("'resolve' plan: metadata is still fetched (for plot/language) even when the feed already supplied a real poster", async () => {
    const cache: MovieCache = {};
    const deps: MovieEnrichmentDeps = {
      resolveImdbId: mock(async () => fakeMatch()),
      getRating: mock(async () => ({ rating: "8.5", datePublished: "" })),
      getMovieMetadata: mock(async () => ({ poster: "https://image.tmdb.org/t/p/w500/should-not-be-used.jpg", plot: "A test plot.", language: "fr" })),
      isPlaceholderPosterUrl: mock(async () => false),
    };

    const movies = await processData(
      apiData({ sanityImagePosterUrl: "https://feed.example.com/real-poster.jpg" }),
      "tmdb-token",
      cache,
      NOW,
      deps
    );

    expect(deps.getMovieMetadata).toHaveBeenCalledTimes(1);
    // The feed's own poster wins -- TMDB's poster is only a fallback for when the feed has none.
    expect(movies[0]!.poster).toBe("https://feed.example.com/real-poster.jpg");
    expect(movies[0]!.plot).toBe("A test plot.");
    expect(movies[0]!.language).toBe("fr");
  });

  test("'rating-only' plan: an already-resolved but still-unrated movie only rechecks the rating -- no title matching, no poster lookup", async () => {
    const cache: MovieCache = {
      "test-movie": {
        imdb_link: "tt9999999",
        imdb_rating: "?",
        poster: "https://example.com/cached.jpg",
        release_date: "2025-01-01T00:00:00.000Z",
        display_release_date: "01 January 2025",
        plot: "Cached plot.",
        language: "da",
        cachedAt: new Date(NOW.getTime() - 1000).toISOString(),
      },
    };
    const deps: MovieEnrichmentDeps = {
      resolveImdbId: mock(async () => fakeMatch()),
      getRating: mock(async () => ({ rating: "7.8", datePublished: "" })),
      getMovieMetadata: mock(async () => ({ poster: "https://example.com/poster.jpg", plot: "Fresh plot.", language: "en" })),
      isPlaceholderPosterUrl: mock(async () => false),
    };

    const movies = await processData(apiData(), "tmdb-token", cache, NOW, deps);

    expect(deps.resolveImdbId).not.toHaveBeenCalled();
    expect(deps.getMovieMetadata).not.toHaveBeenCalled();
    expect(deps.getRating).toHaveBeenCalledTimes(1);
    expect(movies[0]!.imdb_link).toBe("tt9999999");
    expect(movies[0]!.imdb_rating).toBe("7.8");
    expect(movies[0]!.poster).toBe("https://example.com/cached.jpg");
    expect(movies[0]!.plot).toBe("Cached plot.");
    expect(movies[0]!.language).toBe("da");
    expect(cache["test-movie"]).toMatchObject({ imdb_rating: "7.8", plot: "Cached plot.", language: "da", cachedAt: NOW.toISOString() });
  });

  test("'rating-only' plan: still unrated after rechecking -- stays '?', keeps getting checked next build", async () => {
    const cache: MovieCache = {
      "test-movie": {
        imdb_link: "tt9999999",
        imdb_rating: "?",
        poster: "",
        release_date: "2025-01-01T00:00:00.000Z",
        display_release_date: "01 January 2025",
        plot: "",
        language: "",
        cachedAt: new Date(NOW.getTime() - 1000).toISOString(),
      },
    };
    const deps: MovieEnrichmentDeps = {
      resolveImdbId: mock(async () => fakeMatch()),
      getRating: mock(async () => ({ rating: "?", datePublished: "" })),
      getMovieMetadata: mock(async () => ({ poster: "", plot: "", language: "" })),
      isPlaceholderPosterUrl: mock(async () => false),
    };

    const movies = await processData(apiData(), "tmdb-token", cache, NOW, deps);

    expect(deps.resolveImdbId).not.toHaveBeenCalled();
    expect(deps.getMovieMetadata).not.toHaveBeenCalled();
    expect(movies[0]!.imdb_rating).toBe("?");
    expect(cache["test-movie"]!.imdb_rating).toBe("?");
  });

  test("'reuse' plan: a fresh cache entry is used as-is with no network calls", async () => {
    const cache: MovieCache = {
      "test-movie": {
        imdb_link: "tt9999999",
        imdb_rating: "9.0",
        poster: "https://example.com/cached.jpg",
        release_date: "2025-01-01T00:00:00.000Z",
        display_release_date: "01 January 2025",
        plot: "Cached plot.",
        language: "ja",
        cachedAt: new Date(NOW.getTime() - 1000).toISOString(),
      },
    };
    const deps: MovieEnrichmentDeps = {
      resolveImdbId: mock(async () => fakeMatch()),
      getRating: mock(async () => ({ rating: "8.5", datePublished: "" })),
      getMovieMetadata: mock(async () => ({ poster: "https://example.com/poster.jpg", plot: "Fresh plot.", language: "en" })),
      isPlaceholderPosterUrl: mock(async () => false),
    };

    const movies = await processData(apiData(), "tmdb-token", cache, NOW, deps);

    expect(deps.resolveImdbId).not.toHaveBeenCalled();
    expect(deps.getRating).not.toHaveBeenCalled();
    expect(deps.getMovieMetadata).not.toHaveBeenCalled();
    expect(movies[0]!.imdb_rating).toBe("9.0");
    expect(movies[0]!.poster).toBe("https://example.com/cached.jpg");
    expect(movies[0]!.plot).toBe("Cached plot.");
    expect(movies[0]!.language).toBe("ja");
  });

  test("'reuse' plan: fresher feed data (real premiere + real poster) overrides a stale cached 1900 release date and empty poster", async () => {
    const cache: MovieCache = {
      "test-movie": {
        imdb_link: "tt9999999",
        imdb_rating: "9.0",
        poster: "",
        release_date: "1900-01-01T00:00:00.000Z",
        display_release_date: "01 January 1900",
        plot: "Cached plot.",
        language: "ja",
        cachedAt: new Date(NOW.getTime() - 1000).toISOString(),
      },
    };
    const deps: MovieEnrichmentDeps = {
      resolveImdbId: mock(async () => fakeMatch()),
      getRating: mock(async () => ({ rating: "8.5", datePublished: "" })),
      getMovieMetadata: mock(async () => ({ poster: "https://example.com/poster.jpg", plot: "Fresh plot.", language: "en" })),
      isPlaceholderPosterUrl: mock(async () => false),
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
    expect(movies[0]!.plot).toBe("Cached plot.");
    expect(movies[0]!.language).toBe("ja");
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
        plot: "Cached plot.",
        language: "ko",
        cachedAt: new Date(NOW.getTime() - (CACHE_TTL_MS + 1000)).toISOString(),
      },
    };
    const deps: MovieEnrichmentDeps = {
      resolveImdbId: mock(async () => fakeMatch()),
      getRating: mock(async () => ({ rating: "9.2", datePublished: "" })),
      getMovieMetadata: mock(async () => ({ poster: "https://example.com/new-poster.jpg", plot: "Should not overwrite.", language: "xx" })),
      isPlaceholderPosterUrl: mock(async () => false),
    };

    const movies = await processData(apiData(), "tmdb-token", cache, NOW, deps);

    expect(deps.resolveImdbId).not.toHaveBeenCalled();
    expect(deps.getRating).toHaveBeenCalledTimes(1);
    expect(movies[0]!.imdb_link).toBe("tt9999999");
    expect(movies[0]!.imdb_rating).toBe("9.2");
    expect(movies[0]!.poster).toBe("https://example.com/new-poster.jpg");
    // Plot/language are static facts, resolved once and never refreshed -- see movieCache.ts.
    expect(movies[0]!.plot).toBe("Cached plot.");
    expect(movies[0]!.language).toBe("ko");
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
        plot: "Cached plot.",
        language: "ko",
        cachedAt: new Date(NOW.getTime() - (CACHE_TTL_MS + 1000)).toISOString(),
      },
    };
    const deps: MovieEnrichmentDeps = {
      resolveImdbId: mock(async () => fakeMatch()),
      getRating: mock(async () => {
        throw new Error("network error");
      }),
      getMovieMetadata: mock(async () => ({ poster: "https://example.com/new-poster.jpg", plot: "Should not overwrite.", language: "xx" })),
      isPlaceholderPosterUrl: mock(async () => false),
    };

    const movies = await processData(apiData(), "tmdb-token", cache, NOW, deps);

    expect(movies[0]!.imdb_rating).toBe("9.0");
    expect(movies[0]!.poster).toBe("https://example.com/cached.jpg");
    expect(movies[0]!.plot).toBe("Cached plot.");
    expect(movies[0]!.language).toBe("ko");
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
        plot: "",
        language: "",
        cachedAt: new Date(NOW.getTime() - (CACHE_TTL_MS + 1000)).toISOString(),
      },
    };
    const deps: MovieEnrichmentDeps = {
      resolveImdbId: mock(async () => fakeMatch()),
      getRating: mock(async () => ({ rating: "8.5", datePublished: "" })),
      getMovieMetadata: mock(async () => ({ poster: "https://example.com/poster.jpg", plot: "unused", language: "unused" })),
      isPlaceholderPosterUrl: mock(async () => false),
    };

    const movies = await processData(apiData(), "tmdb-token", cache, NOW, deps);

    expect(deps.resolveImdbId).not.toHaveBeenCalled();
    expect(movies[0]!.imdb_rating).toBe("?");
    expect(movies[0]!.plot).toBe("");
  });
});
