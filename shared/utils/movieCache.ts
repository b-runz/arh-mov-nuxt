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

export type FetchPlan = "resolve" | "reuse" | "refresh" | "unresolved" | "rating-only";

export function planMovieFetch(entry: CachedMovie | undefined, now: Date): FetchPlan {
  if (!entry) return "resolve";
  if (!entry.imdb_link) return "unresolved";
  // The imdb id is already resolved -- a still-unrated movie can get a real
  // rating on IMDb any day (as it releases and accumulates votes), so check
  // every build regardless of the TTL. This is deliberately cheap: it's the
  // one-off rating lookup only, never the full match/poster pipeline (see
  // enrichMovieWithImdbData's 'rating-only' branch in app.ts).
  if (entry.imdb_rating === '?') return "rating-only";
  const age = now.getTime() - new Date(entry.cachedAt).getTime();
  return age > CACHE_TTL_MS ? "refresh" : "reuse";
}
