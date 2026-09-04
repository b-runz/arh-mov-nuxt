import { describe, test, expect, mock } from "bun:test";
import { toRecommendable, buildRequestBody, parseRecommendResponse, recommendMovies } from "./geminiRecommend";
import type { Movie } from "../types/movie";

function fakeMovie(overrides: Partial<Movie> = {}): Movie {
  return {
    title: "Test Movie",
    imdb_link: "tt1234567",
    imdb_rating: "7.5",
    id: "test-movie",
    cinemas: {},
    poster: "",
    release_date: "2026-03-15T00:00:00.000Z",
    display_release_date: "15 March 2026",
    plot: "A test plot.",
    language: "da",
    ...overrides,
  };
}

describe("toRecommendable", () => {
  test("maps the fields Gemini needs and drops the rest (no poster/showtime links)", () => {
    const movie = fakeMovie();

    const result = toRecommendable(movie);

    expect(result).toEqual({
      id: "test-movie",
      title: "Test Movie",
      imdb_rating: "7.5",
      year: "2026",
      language: "da",
      plot: "A test plot.",
      showingCount: 0,
    });
  });

  test("sums showings across every cinema and date into showingCount", () => {
    const movie = fakeMovie({
      cinemas: {
        1: { id: 1, name: "Cinema A", showing: { "2026-03-15": [{ time: "18:00", link: "" }, { time: "20:30", link: "" }] } },
        2: { id: 2, name: "Cinema B", showing: { "2026-03-16": [{ time: "19:00", link: "" }] } },
      },
    });

    const result = toRecommendable(movie);

    expect(result.showingCount).toBe(3);
  });
});

describe("buildRequestBody", () => {
  test("embeds the movie list as JSON in the request contents and forces an array-of-id-strings response", () => {
    const movies = [toRecommendable(fakeMovie())];

    const body = buildRequestBody(movies);

    expect(body.contents[0]!.parts[0]!.text).toBe(JSON.stringify(movies));
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema).toEqual({ type: "ARRAY", items: { type: "STRING" } });
    expect(typeof body.system_instruction.parts[0]!.text).toBe("string");
    expect(body.system_instruction.parts[0]!.text.length).toBeGreaterThan(0);
  });
});

describe("parseRecommendResponse", () => {
  test("extracts the ordered id array from a well-formed Gemini response", () => {
    const json = {
      candidates: [{ content: { parts: [{ text: '["movie-a","movie-b"]' }] } }],
    };

    expect(parseRecommendResponse(json)).toEqual(["movie-a", "movie-b"]);
  });

  test("throws when the response has no text content", () => {
    expect(() => parseRecommendResponse({ candidates: [] })).toThrow();
  });

  test("throws when the text isn't a JSON array of strings", () => {
    const json = { candidates: [{ content: { parts: [{ text: '{"not":"an array"}' }] } }] };

    expect(() => parseRecommendResponse(json)).toThrow();
  });
});

describe("recommendMovies", () => {
  test("POSTs to the Gemini endpoint with the api key and returns the parsed id list", async () => {
    const fakeFetch = mock(async (url: string, init: RequestInit) => {
      return {
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: '["test-movie"]' }] } }] }),
      } as Response;
    });

    const ids = await recommendMovies("my-api-key", [toRecommendable(fakeMovie())], fakeFetch as unknown as typeof fetch);

    expect(ids).toEqual(["test-movie"]);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = fakeFetch.mock.calls[0]!;
    expect(url).toContain("generativelanguage.googleapis.com");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("my-api-key");
    // The API key is restricted (HTTP referrer) to this page's own path, but
    // browsers default to sending only the origin -- not the path -- as the
    // Referer for a cross-origin request like this one. Without forcing the
    // full URL, Google sees no path in the referrer and rejects with 403.
    expect(init.referrerPolicy).toBe("unsafe-url");
  });

  test("throws when the Gemini request fails", async () => {
    const fakeFetch = mock(async () => ({ ok: false, status: 429 } as Response));

    await expect(recommendMovies("my-api-key", [], fakeFetch as unknown as typeof fetch)).rejects.toThrow();
  });
});
