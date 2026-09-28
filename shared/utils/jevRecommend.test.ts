import { describe, test, expect, mock } from "bun:test";
import { toRecommendable, buildRequestBody, parseJudgeResponse, recommendMovies } from "./jevRecommend";
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
  test("maps the fields Jev needs and drops the rest (no poster/showtime links)", () => {
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
  test("embeds the movie as a text state plus a single worth_seeing choice question", () => {
    const movie = toRecommendable(fakeMovie());

    const body = buildRequestBody(movie);

    expect(body.state).toContain("Test Movie");
    expect(body.state).toContain("A test plot.");
    expect(body.questions.worth_seeing.type).toBe("choice");
    expect(body.questions.worth_seeing.criteria).toEqual({ yes: "worth recommending", no: "not worth recommending" });
  });
});

describe("parseJudgeResponse", () => {
  test("extracts the choice and confidence from a well-formed Jev answer", () => {
    const json = { answers: { worth_seeing: { type: "choice" as const, choice: "yes", confidence: 0.87, probabilities: { yes: 0.87, no: 0.13 } } } };

    expect(parseJudgeResponse(json)).toEqual({ worthSeeing: true, confidence: 0.87 });
  });

  test("throws when the response has no worth_seeing answer", () => {
    expect(() => parseJudgeResponse({})).toThrow();
  });
});

describe("recommendMovies", () => {
  test("POSTs each movie to the proxy and returns ids judged worth seeing, best confidence first", async () => {
    const responses: Record<string, { choice: string; confidence: number }> = {
      "movie-a": { choice: "yes", confidence: 0.6 },
      "movie-b": { choice: "yes", confidence: 0.9 },
      "movie-c": { choice: "no", confidence: 0.95 },
    };

    const fakeFetch = mock(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const id = body.state.match(/Title: (movie-[abc])/)?.[1];
      const answer = responses[id!]!;
      return {
        ok: true,
        status: 200,
        json: async () => ({ answers: { worth_seeing: { type: "choice", ...answer, probabilities: {} } } }),
      } as Response;
    });

    const movies = ["movie-a", "movie-b", "movie-c"].map((id) =>
      toRecommendable(fakeMovie({ id, title: id }))
    );

    const ids = await recommendMovies(movies, "http://localhost:7071/api/jevRecommend", "test-token", fakeFetch as unknown as typeof fetch);

    expect(ids).toEqual(["movie-b", "movie-a"]);
    expect(fakeFetch).toHaveBeenCalledTimes(3);
    expect(fakeFetch.mock.calls[0]![0]).toBe("http://localhost:7071/api/jevRecommend");
    expect((fakeFetch.mock.calls[0]![1]!.headers as Record<string, string>)["x-functions-key"]).toBe("test-token");
  });

  test("throws when the proxy request fails", async () => {
    const fakeFetch = mock(async () => ({ ok: false, status: 500 } as Response));

    await expect(
      recommendMovies([toRecommendable(fakeMovie())], "http://localhost:7071/api/jevRecommend", "test-token", fakeFetch as unknown as typeof fetch)
    ).rejects.toThrow();
  });

  test("throws a specific error when the proxy rejects the token", async () => {
    const fakeFetch = mock(async () => ({ ok: false, status: 401 } as Response));

    await expect(
      recommendMovies([toRecommendable(fakeMovie())], "http://localhost:7071/api/jevRecommend", "bad-token", fakeFetch as unknown as typeof fetch)
    ).rejects.toThrow(/token/i);
  });
});
