import { describe, test, expect, mock } from "bun:test";
import { processData, type MovieEnrichmentDeps } from "./app";
import type { ImdbMatch } from "./imdbMatcher";

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
    candidateOriginalTitle: "Test Movie",
    candidateYear: "2026",
    source: "tmdb+imdb",
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<MovieEnrichmentDeps> = {}): MovieEnrichmentDeps {
  return {
    resolveImdbId: mock(async () => fakeMatch()),
    getRating: mock(async () => ({ rating: "8.5", datePublished: "" })),
    getPosterUrl: mock(async () => ""),
    isPlaceholderPosterUrl: mock(async () => false),
    ...overrides,
  };
}

describe("processData", () => {
  test("a high-confidence match sets the IMDb rating and link", async () => {
    const deps = fakeDeps({
      resolveImdbId: mock(async () => fakeMatch()),
      getRating: mock(async () => ({ rating: "8.5", datePublished: "" })),
    });

    const movies = await processData(apiData(), "tmdb-token", deps);

    expect(deps.resolveImdbId).toHaveBeenCalledTimes(1);
    expect(movies[0]!.imdb_rating).toBe("8.5");
    expect(movies[0]!.imdb_link).toBe("tt1234567");
  });

  test("a low-confidence match is not applied -- rating stays unresolved", async () => {
    const deps = fakeDeps({
      resolveImdbId: mock(async () => fakeMatch({ confidence: "low" })),
      getRating: mock(async () => ({ rating: "?", datePublished: "" })),
    });

    const movies = await processData(apiData(), "tmdb-token", deps);

    expect(deps.getRating).not.toHaveBeenCalled();
    expect(movies[0]!.imdb_rating).toBe("?");
    expect(movies[0]!.imdb_link).toBe("");
  });

  test("a poster url flagged as a placeholder (e.g. kino.dk's 'no poster' card) is not kept -- falls through to TMDB instead", async () => {
    const deps = fakeDeps({
      resolveImdbId: mock(async () => fakeMatch()),
      getRating: mock(async () => ({ rating: "8.5", datePublished: "" })),
      getPosterUrl: mock(async () => "https://image.tmdb.org/t/p/w500/real.jpg"),
      isPlaceholderPosterUrl: mock(async (url: string) => url === "https://cdn.sanity.io/placeholder.jpg"),
    });

    const movies = await processData(
      apiData({ sanityImagePosterUrl: "https://cdn.sanity.io/placeholder.jpg" }),
      "tmdb-token",
      deps
    );

    expect(movies[0]!.poster).toBe("https://image.tmdb.org/t/p/w500/real.jpg");
  });

  test("a real poster already supplied by the feed is kept -- TMDB is only a fallback", async () => {
    const deps = fakeDeps({
      resolveImdbId: mock(async () => fakeMatch()),
      getRating: mock(async () => ({ rating: "8.5", datePublished: "" })),
      getPosterUrl: mock(async () => "https://image.tmdb.org/t/p/w500/should-not-be-used.jpg"),
      isPlaceholderPosterUrl: mock(async () => false),
    });

    const movies = await processData(
      apiData({ sanityImagePosterUrl: "https://feed.example.com/real-poster.jpg" }),
      "tmdb-token",
      deps
    );

    expect(deps.getPosterUrl).not.toHaveBeenCalled();
    expect(movies[0]!.poster).toBe("https://feed.example.com/real-poster.jpg");
  });

  test("resolveImdbId failing is caught -- the movie is still returned, just unresolved", async () => {
    const deps = fakeDeps({
      resolveImdbId: mock(async () => {
        throw new Error("network error");
      }),
    });

    const movies = await processData(apiData(), "tmdb-token", deps);

    expect(movies).toHaveLength(1);
    expect(movies[0]!.imdb_rating).toBe("?");
  });
});
