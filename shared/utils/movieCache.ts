export interface CachedMovie {
  imdb_link: string;
  imdb_rating: string;
  poster: string;
  release_date: string;
  display_release_date: string;
  cachedAt: string;
}

export type MovieCache = Record<string, CachedMovie>;

export const MOVIE_CACHE_PATH = ".cache/movie-cache.json";

// A movie's IMDb id resolution never changes once found, and a match that
// stayed unresolved isn't expected to suddenly resolve later (see
// docs/superpowers/specs/2026-07-30-movie-match-cache-design.md) -- only
// rating/poster are ever refreshed, and only for already-resolved movies.
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type FetchPlan = "resolve" | "reuse" | "refresh" | "unresolved";

export function planMovieFetch(entry: CachedMovie | undefined, now: Date): FetchPlan {
  if (!entry) return "resolve";
  if (!entry.imdb_link) return "unresolved";
  // A '?' rating means the last attempt to fetch a rating failed or was
  // rate-limited (getRating never throws -- it swallows all failures into
  // '?'), not that the movie genuinely has no rating. Retry it on every
  // build, ignoring the TTL, until it actually gets a real rating.
  if (entry.imdb_rating === '?') return "refresh";
  const age = now.getTime() - new Date(entry.cachedAt).getTime();
  return age > CACHE_TTL_MS ? "refresh" : "reuse";
}
