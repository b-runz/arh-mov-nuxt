import type { Movie } from "../types/movie";
import { runWithConcurrencyLimit } from "./concurrencyLimit";

export interface RecommendableMovie {
  id: string;
  title: string;
  imdb_rating: string;
  year: string;
  language: string;
  plot: string;
  showingCount: number;
}

const TASTE_INSTRUCTIONS = "The user's taste: smaller / independent films over mainstream blockbusters, foreign-language films, one-off or limited/special screenings (a low showingCount) over long theatrical runs, and classic re-releases. Given the movie described in the state, is it worth recommending to this user?";

// Jev judges one "state" (a piece of text) at a time, so there's no
// batched equivalent of the old single Gemini call over the whole list --
// each movie gets its own request instead.
const RECOMMEND_CONCURRENCY = 5;

// Strips the Movie type down to just what the recommendation prompt needs --
// no poster URLs or per-cinema showtime links, which the model has no use
// for. showingCount is a stand-in for "one-off screening" (see
// TASTE_INSTRUCTIONS): the raw cinema/showing structure isn't meaningful to
// the model, but the total count is.
export function toRecommendable(movie: Movie): RecommendableMovie {
  const showingCount = Object.values(movie.cinemas).reduce(
    (sum, cinema) => sum + Object.values(cinema.showing).reduce((s, showings) => s + showings.length, 0),
    0
  );

  return {
    id: movie.id,
    title: movie.title,
    imdb_rating: movie.imdb_rating,
    year: movie.release_date.slice(0, 4),
    language: movie.language,
    plot: movie.plot,
    showingCount,
  };
}

export function buildState(movie: RecommendableMovie): string {
  return `Title: ${movie.title}\nYear: ${movie.year}\nLanguage: ${movie.language}\nIMDb rating: ${movie.imdb_rating}\nCurrent showing count: ${movie.showingCount}\nPlot: ${movie.plot}`;
}

export function buildRequestBody(movie: RecommendableMovie) {
  return {
    state: buildState(movie),
    questions: {
      worth_seeing: {
        type: "choice",
        instructions: TASTE_INSTRUCTIONS,
        criteria: { yes: "worth recommending", no: "not worth recommending" },
      },
    },
  };
}

interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

interface JevProxyResponse {
  answers?: { worth_seeing?: JevChoiceAnswer };
}

export function parseJudgeResponse(json: JevProxyResponse): { worthSeeing: boolean; confidence: number } {
  const answer = json.answers?.worth_seeing;
  if (!answer) {
    throw new Error("Jev proxy response did not include a worth_seeing answer");
  }
  return { worthSeeing: answer.choice === "yes", confidence: answer.confidence };
}

async function judgeMovie(
  movie: RecommendableMovie,
  proxyUrl: string,
  proxyToken: string,
  fetchFn: typeof fetch
): Promise<{ id: string; worthSeeing: boolean; confidence: number }> {
  const response = await fetchFn(proxyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-functions-key": proxyToken,
    },
    body: JSON.stringify(buildRequestBody(movie)),
  });

  if (response.status === 401) {
    throw new Error("Jev proxy rejected the token -- it may be wrong or revoked");
  }
  if (!response.ok) {
    throw new Error(`Jev proxy request failed: ${response.status}`);
  }

  const { worthSeeing, confidence } = parseJudgeResponse(await response.json());
  return { id: movie.id, worthSeeing, confidence };
}

// Calls our own Azure Function (see azure-functions/jev-proxy), which holds
// the Jev API key server-side and forwards the judgment request -- unlike
// Gemini, Jev's API disallows browser-origin calls outright, so there's no
// direct-from-browser option here. proxyToken is the Function's own access
// key (authLevel: "function") -- without it the Azure gateway itself
// rejects the request with a 401 before our code, or Jev, ever runs.
export async function recommendMovies(
  movies: RecommendableMovie[],
  proxyUrl: string,
  proxyToken: string,
  fetchFn: typeof fetch = fetch
): Promise<string[]> {
  const tasks = movies.map((movie) => () => judgeMovie(movie, proxyUrl, proxyToken, fetchFn));
  const judgments = await runWithConcurrencyLimit(tasks, RECOMMEND_CONCURRENCY);

  return judgments
    .filter((judgment) => judgment.worthSeeing)
    .sort((a, b) => b.confidence - a.confidence)
    .map((judgment) => judgment.id);
}
