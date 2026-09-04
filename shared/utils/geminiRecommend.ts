import type { Movie } from "../types/movie";

export interface RecommendableMovie {
  id: string;
  title: string;
  imdb_rating: string;
  year: string;
  language: string;
  plot: string;
  showingCount: number;
}

const MODEL = "gemini-2.5-flash";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const TASTE_PROMPT = `You are a film curator helping the user decide which of the currently-showing movies below are worth seeing. The user's taste: smaller / independent films over mainstream blockbusters, foreign-language films, one-off or limited/special screenings (a low showingCount) over long theatrical runs, and classic re-releases. You will receive a JSON array of movies, each with id, title, imdb_rating, year, language, plot, and showingCount. Return ONLY a JSON array of the "id" strings of the movies worth recommending, ordered best match first. Exclude movies that don't fit this taste. Do not include anything except the id strings that were given to you.`;

// Strips the Movie type down to just what the recommendation prompt needs --
// no poster URLs or per-cinema showtime links, which the model has no use
// for and would only spend tokens on. showingCount is a stand-in for
// "one-off screening" (see the taste prompt): the raw cinema/showing
// structure isn't meaningful to the model, but the total count is.
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

export function buildRequestBody(movies: RecommendableMovie[]) {
  return {
    system_instruction: { parts: [{ text: TASTE_PROMPT }] },
    contents: [{ parts: [{ text: JSON.stringify(movies) }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: { type: "ARRAY", items: { type: "STRING" } },
    },
  };
}

// Gemini's structured-output mode still returns the JSON as a *string*
// inside candidates[0].content.parts[0].text, matching responseSchema --
// it isn't parsed into the response body itself.
export function parseRecommendResponse(json: any): string[] {
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error("Gemini response did not include any text content");
  }

  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error("Gemini response was not a JSON array of movie ids");
  }

  return parsed;
}

// Calls Gemini directly from the browser -- this app is statically
// generated (see nuxt.config.ts), so there's no live server to hold the API
// key or handle a POST at runtime. The key comes from the caller (stored in
// the user's own browser) and only ever travels to Google, never to us.
export async function recommendMovies(
  apiKey: string,
  movies: RecommendableMovie[],
  fetchFn: typeof fetch = fetch
): Promise<string[]> {
  const response = await fetchFn(GEMINI_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(buildRequestBody(movies)),
  });

  if (!response.ok) {
    throw new Error(`Gemini request failed: ${response.status}`);
  }

  return parseRecommendResponse(await response.json());
}
