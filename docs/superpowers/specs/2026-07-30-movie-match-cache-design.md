# Movie match cache

## Problem

`nuxt generate` in CI (`.github/workflows/nuxtjs.yml`) takes ~31s end to end.
A build log pulled from GitHub Actions (run 30498095944) shows exactly where
that time goes:

- Vite client build: 2.96s
- Vite server build: 0.88s
- Prerendering: 16.4s total, but **14.2s of that is a single route: `/`**.
  Every `/movies/[id]` route after it renders in 10-170ms.

`/` is slow because `useMovies()` (`composables/useMovies.ts`) fetches the
cinema schedule, then `processData()` (`shared/utils/app.ts`) runs, for every
movie in it (~107 in the sampled run):

1. `resolveImdbId()` (`shared/utils/imdbMatcher.ts`) - searches TMDB, IMDb's
   GraphQL API, and IMDb's suggestion API in parallel (TMDB alone can fire up
   to ~7 requests per movie: one search + up to six detail lookups), then
   falls back to a paradisbio.dk scrape and sequential title-stripping
   retries if the first pass isn't high confidence.
2. `getRating()` - one IMDb GraphQL call.
3. `get_poster_url()` - one TMDB call.

Across ~107 movies this is hundreds of requests per build, and the log shows
TMDB 429s (rate limited) as a direct result. The Vue/Vite compile step is not
the bottleneck; it's already fast for an app this size.

The actual lever for build time is that **the movie catalog barely changes
between builds** - the same ~107 movies show up run after run, but the full
matching pipeline reruns for all of them every time.

## Goal

Cache each movie's resolved match/rating/poster across builds so the
expensive matching pipeline only ever runs once per movie - genuinely new
listings pay the full cost; everything already seen before doesn't.

## Non-goals

- Changing the matching algorithm itself (`imdbMatcher.ts` is untouched).
- Concurrency throttling of the matching fan-out. Once the cache is warm,
  the number of *new* movies per build is small, so this isn't expected to
  be needed; can be revisited later if it is.
- Pruning old/no-longer-showing movies from the cache. Entries are tiny
  (well under 1KB each); even years of accumulated titles stay negligible
  in size, so there's no need to expire them by schedule presence.

## Design

### Cache shape and location

A single JSON file, `.cache/movie-cache.json`, holding a
`Record<string, CachedMovie>` keyed by the same slug (`id = createUrlSlug(title)`)
already used to dedupe movies within a build - no new fingerprinting scheme.

```ts
interface CachedMovie {
  imdb_link: string;        // '' if unresolved
  imdb_rating: string;      // '?' if unresolved
  poster: string;
  release_date: string;
  display_release_date: string;
  cachedAt: string;         // ISO timestamp
}
```

`cinemas`/showtimes are never cached - they're rebuilt fresh from the
schedule feed every build regardless, since showtimes change constantly.

### Per-movie decision logic

Replaces the unconditional resolve-every-time in `processData()`:

- **No cache entry** -> run the existing full pipeline
  (`resolveImdbId` -> `getRating` -> `get_poster_url`) exactly as today.
  Write a cache entry regardless of outcome, including when the movie
  doesn't resolve (medium/high confidence not reached): the existing logic
  in `app.ts` already only sets `imdb_link`/`imdb_rating` for medium/high
  confidence matches, so an unresolved attempt is cached as
  `imdb_link: '', imdb_rating: '?'`. This means a low-confidence guess is
  never baked in as if it were correct - it's recorded as "unresolved," not
  as a wrong answer - while still ensuring the expensive matching fan-out
  never runs again for that movie.
- **Cache entry exists, `imdb_link` set (resolved)** - the id resolution is
  permanent (a movie doesn't change its IMDb id), so `resolveImdbId` is
  never re-run for it. Only `getRating` + `get_poster_url` are refreshed,
  and only if `cachedAt` is more than 7 days old (1-2 cheap calls instead of
  the full matching fan-out).
- **Cache entry exists, `imdb_link` empty (previously unresolved)** -
  nothing to refresh (there's no imdb id to query rating/poster with) -
  skip entirely, forever. `cachedAt` on this kind of entry is informational
  only (when the attempt happened) and isn't used in any TTL check.

### Known trade-off: no automatic re-resolution

A movie that resolves wrong, or fails to resolve, on its first build stays
that way permanently - there's no automatic retry even if the sources would
now agree, since the whole point is that the matching pipeline never runs
twice for the same movie. This is intentional per product decision, not an
oversight. The escape hatch is the cache-invalidation workflow below, which
forces every movie to be re-resolved from scratch on the next build.

### Error handling

- A missing or corrupt cache file at load time is treated as an empty
  cache (this is also just how the very first build behaves).
- If a 7-day-stale refresh's `getRating`/`get_poster_url` call fails or
  comes back empty (transient network hiccup), fall back to the existing
  stale cached value instead of overwriting good data with `'?'`/empty - a
  refresh attempt must never make things worse than not refreshing.

### CI wiring

`.github/workflows/nuxtjs.yml`: add an `actions/cache` step before
`bun run generate`, restoring path `.cache/`, with:

- `key: movie-cache-${{ github.run_id }}` (unique every run, so the exact
  key never hits and the action always saves at the end)
- `restore-keys: movie-cache-` (prefix match, so restore always pulls the
  most recent prior run's cache)

No permission changes needed on the build workflow - this is pure
cache-restore/save, no git commits involved.

### Cache invalidation workflow

`.github/workflows/invalidate-movie-cache.yml` (already added): a manual
`workflow_dispatch` workflow that runs `gh cache delete --all` for the repo.
Use it after tuning the matching algorithm, or any time a clean re-match of
every movie is wanted.

## Testing

Unit-test the per-movie decision logic (fresh cache hit / stale refresh /
cache miss / previously-unresolved) and the stale-fallback-on-refresh-failure
behavior directly against the cache module, with `resolveImdbId`/`getRating`/
`get_poster_url` mocked - no real network calls needed. The existing
functions themselves are unchanged.
