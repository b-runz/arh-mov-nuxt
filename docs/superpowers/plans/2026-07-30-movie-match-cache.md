# Movie Match Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cache each movie's resolved IMDb match, rating, and poster across builds so the expensive multi-source matching pipeline in `resolveImdbId` only ever runs once per movie, instead of on every `nuxt generate`.

**Architecture:** `shared/utils/movieCache.ts` owns the cache's shape and its pure fresh/stale/miss decision logic (`planMovieFetch`) - no filesystem access, so it's safe for Nuxt's isomorphic `shared/` directory. `shared/utils/app.ts`'s `processData()` takes the cache as a parameter and, per movie, either reuses cached data, refreshes only rating/poster, or runs the full resolution pipeline - all through an injectable `deps` object so this branching is unit-testable without network calls. The actual filesystem load/save (`server/utils/movieCacheStorage.ts`, uses `node:fs`) and the GraphQL fetch + `processData()` orchestration live in a new Nitro server API route, `server/api/movies.get.ts` - server-only code the client only ever reaches over HTTP, never via a bundled `import`, which is what actually keeps `node:fs` out of the client bundle (a Task 3 revision found that `import.meta.server` guards on a direct/dynamic import do NOT achieve this in this Nuxt/Vite setup - see the note at the top of Task 3). `composables/useMovies.ts` becomes a thin `useFetch('/api/movies')` wrapper. CI restores/saves `.cache/` via `actions/cache` across workflow runs.

**Tech Stack:** Bun (package manager, `bun test` for unit tests - no new test framework dependency), TypeScript, Nuxt 4 composables, GitHub Actions (`actions/cache@v4`).

## Global Constraints

- Cache TTL is exactly 7 days (604,800,000 ms) for refreshing rating/poster on an already-resolved movie. The match/id itself never expires.
- A movie that never resolves (no cache entry with a set `imdb_link`) is still written to the cache after its first attempt, so `resolveImdbId` never runs for it again either.
- Cache file path is `.cache/movie-cache.json` (`.cache` is already gitignored - confirmed in `.gitignore`).
- No new dependencies. Tests run via `bun test`; no `vitest`/`jest` install.
- `resolveImdbId`, `getRating`, `get_poster_url` (in `shared/utils/imdbMatcher.ts`, `shared/utils/imdb.ts`, `shared/utils/tmdb_poster.ts`) are not modified.
- CI cache step uses `actions/cache@v4` with `key: movie-cache-${{ github.run_id }}` and `restore-keys: movie-cache-` (exact key never hits, so it always saves at the end; prefix match always restores the latest prior run).
- The cache-invalidation workflow (`.github/workflows/invalidate-movie-cache.yml`) already exists from the design phase - no changes needed to it in this plan.
- Spec: `docs/superpowers/specs/2026-07-30-movie-match-cache-design.md`.

---

### Task 1: Cache module (`shared/utils/movieCache.ts`)

**Files:**
- Create: `shared/utils/movieCache.ts`
- Create: `shared/utils/movieCache.test.ts`
- Modify: `package.json` (add `test` script)

**Interfaces:**
- Produces (used by Task 2 and Task 3):
  - `interface CachedMovie { imdb_link: string; imdb_rating: string; poster: string; release_date: string; display_release_date: string; cachedAt: string }`
  - `type MovieCache = Record<string, CachedMovie>`
  - `const CACHE_TTL_MS: number`
  - `const MOVIE_CACHE_PATH: string` (value: `.cache/movie-cache.json`)
  - `type FetchPlan = "resolve" | "reuse" | "refresh" | "unresolved"`
  - `function planMovieFetch(entry: CachedMovie | undefined, now: Date): FetchPlan`
  - `function loadMovieCache(path: string): Promise<MovieCache>`
  - `function saveMovieCache(path: string, cache: MovieCache): Promise<void>`

- [ ] **Step 1: Write the failing tests for `planMovieFetch`**

Create `shared/utils/movieCache.test.ts`:

```ts
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planMovieFetch,
  loadMovieCache,
  saveMovieCache,
  CACHE_TTL_MS,
  type CachedMovie,
} from "./movieCache";

describe("planMovieFetch", () => {
  const now = new Date("2026-07-30T00:00:00.000Z");

  test("returns 'resolve' when there is no cache entry", () => {
    expect(planMovieFetch(undefined, now)).toBe("resolve");
  });

  test("returns 'unresolved' when the cached entry has no imdb_link", () => {
    const entry: CachedMovie = {
      imdb_link: "",
      imdb_rating: "?",
      poster: "",
      release_date: "",
      display_release_date: "",
      cachedAt: now.toISOString(),
    };
    expect(planMovieFetch(entry, now)).toBe("unresolved");
  });

  test("returns 'reuse' when the cached entry is resolved and within the TTL", () => {
    const entry: CachedMovie = {
      imdb_link: "tt1234567",
      imdb_rating: "7.5",
      poster: "https://example.com/p.jpg",
      release_date: "2026-01-01T00:00:00.000Z",
      display_release_date: "01 January 2026",
      cachedAt: new Date(now.getTime() - (CACHE_TTL_MS - 1000)).toISOString(),
    };
    expect(planMovieFetch(entry, now)).toBe("reuse");
  });

  test("returns 'refresh' when the cached entry is resolved but older than the TTL", () => {
    const entry: CachedMovie = {
      imdb_link: "tt1234567",
      imdb_rating: "7.5",
      poster: "https://example.com/p.jpg",
      release_date: "2026-01-01T00:00:00.000Z",
      display_release_date: "01 January 2026",
      cachedAt: new Date(now.getTime() - (CACHE_TTL_MS + 1000)).toISOString(),
    };
    expect(planMovieFetch(entry, now)).toBe("refresh");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test shared/utils/movieCache.test.ts`
Expected: FAIL - `movieCache` module not found (nothing implemented yet).

- [ ] **Step 3: Implement `planMovieFetch` and the cache types**

Create `shared/utils/movieCache.ts`:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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
  const age = now.getTime() - new Date(entry.cachedAt).getTime();
  return age > CACHE_TTL_MS ? "refresh" : "reuse";
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test shared/utils/movieCache.test.ts`
Expected: PASS (4 tests for `planMovieFetch`).

- [ ] **Step 5: Add the failing tests for `loadMovieCache` / `saveMovieCache`**

Append to `shared/utils/movieCache.test.ts`:

```ts
describe("loadMovieCache / saveMovieCache", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("loadMovieCache returns {} when the file doesn't exist", async () => {
    dir = mkdtempSync(join(tmpdir(), "movie-cache-test-"));
    const cache = await loadMovieCache(join(dir, "missing.json"));
    expect(cache).toEqual({});
  });

  test("loadMovieCache returns {} when the file has invalid JSON", async () => {
    dir = mkdtempSync(join(tmpdir(), "movie-cache-test-"));
    const path = join(dir, "corrupt.json");
    await Bun.write(path, "{ not valid json");
    const cache = await loadMovieCache(path);
    expect(cache).toEqual({});
  });

  test("saveMovieCache then loadMovieCache round-trips the data, creating missing directories", async () => {
    dir = mkdtempSync(join(tmpdir(), "movie-cache-test-"));
    const path = join(dir, "nested", "movie-cache.json");
    const data: Record<string, CachedMovie> = {
      "some-movie": {
        imdb_link: "tt1234567",
        imdb_rating: "8.1",
        poster: "https://example.com/p.jpg",
        release_date: "2026-01-01T00:00:00.000Z",
        display_release_date: "01 January 2026",
        cachedAt: "2026-07-30T00:00:00.000Z",
      },
    };

    await saveMovieCache(path, data);
    const loaded = await loadMovieCache(path);

    expect(loaded).toEqual(data);
  });
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `bun test shared/utils/movieCache.test.ts`
Expected: FAIL - `loadMovieCache`/`saveMovieCache` not defined.

- [ ] **Step 7: Implement `loadMovieCache` and `saveMovieCache`**

Append to `shared/utils/movieCache.ts`:

```ts
export async function loadMovieCache(path: string): Promise<MovieCache> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as MovieCache) : {};
  } catch {
    return {};
  }
}

export async function saveMovieCache(path: string, cache: MovieCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cache, null, 2), "utf-8");
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `bun test shared/utils/movieCache.test.ts`
Expected: PASS (7 tests total).

- [ ] **Step 9: Add the `test` script to `package.json`**

In `package.json`, add to `"scripts"`:

```json
    "test": "bun test",
```

- [ ] **Step 10: Run the full test suite and commit**

Run: `bun test`
Expected: PASS (all `movieCache.test.ts` tests).

```bash
git add shared/utils/movieCache.ts shared/utils/movieCache.test.ts package.json
git commit -m "feat: add movie match cache module with fresh/stale/miss decision logic"
```

---

### Task 2: Wire the cache into `processData` (`shared/utils/app.ts`)

**Files:**
- Modify: `shared/utils/app.ts:1-6` (imports), `shared/utils/app.ts:62-154` (`processData` and its per-movie resolution logic)
- Create: `shared/utils/app.test.ts`

**Interfaces:**
- Consumes: `planMovieFetch`, `MovieCache`, `CachedMovie` from `shared/utils/movieCache.ts` (Task 1); `resolveImdbId` from `./imdbMatcher`, `getRating` from `./imdb`, `get_poster_url` from `./tmdb_poster` (all pre-existing, unchanged).
- Produces (used by Task 3): `processData(data: any, tmdbApiKey: string | undefined, cache: MovieCache, now?: Date, deps?: MovieEnrichmentDeps): Promise<Movie[]>` - `cache` is mutated in place with any newly resolved/refreshed entries.

- [ ] **Step 1: Write the failing tests for `processData`'s cache behavior**

Create `shared/utils/app.test.ts`:

```ts
import { describe, test, expect, mock } from "bun:test";
import { processData, type MovieEnrichmentDeps } from "./app";
import { CACHE_TTL_MS, type MovieCache } from "./movieCache";
import type { ImdbMatch } from "./imdbMatcher";

const NOW = new Date("2026-07-30T00:00:00.000Z");

function apiData(overrides: Partial<{ title: string; sanityImagePosterUrl: string }> = {}) {
  return {
    data: {
      movieQuery: {
        getCurrentMovies: [
          {
            title: overrides.title ?? "Test Movie",
            titleOriginal: "",
            mainVersionId: "1",
            premiere: "2026-01-01",
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test shared/utils/app.test.ts`
Expected: FAIL - `processData` doesn't accept a `cache`/`deps` argument yet, and `MovieEnrichmentDeps` isn't exported.

- [ ] **Step 3: Update imports and add the `MovieEnrichmentDeps` type in `app.ts`**

At the top of `shared/utils/app.ts`, change:

```ts

import moment from 'moment';
import type { Movie } from "../types/movie";
import { getRating } from './imdb';
import { resolveImdbId, type KinoMovieInput } from './imdbMatcher';
import { get_poster_url } from './tmdb_poster';
```

to:

```ts

import moment from 'moment';
import type { Movie } from "../types/movie";
import { getRating } from './imdb';
import { resolveImdbId, type KinoMovieInput } from './imdbMatcher';
import { get_poster_url } from './tmdb_poster';
import { planMovieFetch, type MovieCache } from './movieCache';

export interface MovieEnrichmentDeps {
    resolveImdbId: typeof resolveImdbId;
    getRating: typeof getRating;
    getPosterUrl: typeof get_poster_url;
}

const defaultDeps: MovieEnrichmentDeps = {
    resolveImdbId,
    getRating,
    getPosterUrl: get_poster_url,
};
```

- [ ] **Step 4: Replace the inline resolution logic with `enrichMovieWithImdbData` and update `processData`'s signature**

In `shared/utils/app.ts`, replace the whole `processData` function (originally lines 62-154, from `export async function processData` through its closing `}`) with:

```ts
async function enrichMovieWithImdbData(
    movies: Record<string, Movie>,
    id: string,
    apiMovie: ApiMovie,
    release_date: moment.Moment,
    tmdbApiKey: string,
    cache: MovieCache,
    now: Date,
    deps: MovieEnrichmentDeps
): Promise<void> {
    const plan = planMovieFetch(cache[id], now);

    if (plan === 'unresolved') return;

    if (plan === 'reuse') {
        const cached = cache[id]!;
        movies[id]!.imdb_link = cached.imdb_link;
        movies[id]!.imdb_rating = cached.imdb_rating;
        movies[id]!.poster = cached.poster;
        movies[id]!.release_date = cached.release_date;
        movies[id]!.display_release_date = cached.display_release_date;
        return;
    }

    try {
        if (plan === 'refresh') {
            const cached = cache[id]!;
            // Apply the stale cached result up front so a failed refresh still
            // leaves this movie fully resolved, just with last build's rating/poster.
            movies[id]!.imdb_link = cached.imdb_link;
            movies[id]!.imdb_rating = cached.imdb_rating;
            movies[id]!.poster = cached.poster;
            movies[id]!.release_date = cached.release_date;
            movies[id]!.display_release_date = cached.display_release_date;

            const imdbData = await deps.getRating(cached.imdb_link);
            const rating = imdbData.rating !== '?' ? imdbData.rating : cached.imdb_rating;
            const tmdbPoster = tmdbApiKey ? await deps.getPosterUrl(cached.imdb_link, tmdbApiKey) : '';
            const poster = tmdbPoster || cached.poster;

            movies[id]!.imdb_rating = rating;
            movies[id]!.poster = poster;

            cache[id] = {
                imdb_link: cached.imdb_link,
                imdb_rating: rating,
                poster,
                release_date: cached.release_date,
                display_release_date: cached.display_release_date,
                cachedAt: now.toISOString(),
            };
            return;
        }

        // plan === 'resolve': this movie has never been attempted before.
        const match = await deps.resolveImdbId(buildKinoMovieInput(apiMovie, release_date), tmdbApiKey);
        if (match && (match.confidence === 'high' || match.confidence === 'medium')) {
            const imdbData = await deps.getRating(match.imdbId);
            movies[id]!.imdb_rating = imdbData.rating;
            movies[id]!.imdb_link = match.imdbId;

            if (imdbData.datePublished && release_date.year() === 1900) {
                const imdbDate = moment(imdbData.datePublished, 'YYYY-MM-DD');
                if (imdbDate.isValid()) {
                    movies[id]!.release_date = imdbDate.toISOString();
                    movies[id]!.display_release_date = formatDisplayDate(imdbDate);
                }
            }

            if (!movies[id]!.poster && tmdbApiKey) {
                const tmdbPoster = await deps.getPosterUrl(match.imdbId, tmdbApiKey) || match.tmdbPosterUrl;
                if (tmdbPoster) movies[id]!.poster = tmdbPoster;
            }
        }

        // Cache whatever we ended up with -- resolved or not -- so resolveImdbId
        // never runs again for this movie (see
        // docs/superpowers/specs/2026-07-30-movie-match-cache-design.md).
        cache[id] = {
            imdb_link: movies[id]!.imdb_link,
            imdb_rating: movies[id]!.imdb_rating,
            poster: movies[id]!.poster,
            release_date: movies[id]!.release_date,
            display_release_date: movies[id]!.display_release_date,
            cachedAt: now.toISOString(),
        };
    } catch (error) {
        console.warn(`[processData] IMDb resolution failed for "${apiMovie.title}": ${(error as Error)?.message ?? error}`);
    }
}

export async function processData(
    data: any,
    tmdbApiKey: string | undefined,
    cache: MovieCache,
    now: Date = new Date(),
    deps: MovieEnrichmentDeps = defaultDeps
): Promise<Movie[]> {
    // Perform any further processing or rendering with the transformed data
    let movies: Record<string, Movie> = {}
    let imdbPromises: Promise<void>[] = []
    moment.locale("da")

    const apiMovies: ApiMovie[] = data?.data?.movieQuery?.getCurrentMovies ?? []
    const sharedPosterUrls = findSharedPosterUrls(apiMovies)

    for (const apiMovie of apiMovies) {
        const title = apiMovie.title
        if (!title) continue

        const id = createUrlSlug(title)
        const release_date = parseReleaseDate(apiMovie.premiere)

        if (!(id in movies)) {
            const isPlaceholderPoster = !apiMovie.sanityImagePosterUrl || sharedPosterUrls.has(apiMovie.sanityImagePosterUrl)
            // Empty string means "no real poster" -- the UI renders a
            // title-card fallback for this instead of a placeholder image.
            let poster_uri = isPlaceholderPoster ? '' : apiMovie.sanityImagePosterUrl

            movies[id] = {
                title: title,
                imdb_link: '',
                imdb_rating: '?', // Will be updated by IMDB promise
                cinemas: {},
                id: id,
                poster: poster_uri,
                release_date: release_date.toISOString(),
                display_release_date: release_date.locale("en").format('DD. MMM. YYYY')
            }

            imdbPromises.push(enrichMovieWithImdbData(movies, id, apiMovie, release_date, tmdbApiKey ?? "", cache, now, deps));
        }

        const movie = movies[id]
        if (movie) {
            for (const show of apiMovie.shows ?? []) {
                const date = show.showStart.slice(0, 10);
                const time = show.showStart.slice(11, 16);

                if (!movie.cinemas[show.theaterId]) {
                    movie.cinemas[show.theaterId] = { id: show.theaterId, name: show.theaterName, showing: {} };
                }
                const cinema = movie.cinemas[show.theaterId]!;
                if (!cinema.showing[date]) {
                    cinema.showing[date] = [];
                }
                cinema.showing[date]!.push({ time, link: show.ticketSaleUrl });
            }
        }
    }

    // Wait for all IMDB data to be fetched
    await Promise.all(imdbPromises);

    return sortMoviesByPremiereDate(movies);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test shared/utils/app.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Run the full test suite and commit**

Run: `bun test`
Expected: PASS (all tests from Task 1 and Task 2).

```bash
git add shared/utils/app.ts shared/utils/app.test.ts
git commit -m "feat: make processData cache-aware via an injectable deps object"
```

---

### Task 3 (REVISED): Move the cache and data fetch into a Nitro server API route

> **Why this task changed:** the original Task 3 (guard `useMovies.ts`'s cache load/save
> with `if (import.meta.server)` and a dynamic import of `shared/utils/movieCache.ts`)
> was attempted and failed: `bun run generate` broke the client Vite build with
> `RollupError: "readFile" is not exported by "__vite-browser-external"`. Root cause,
> confirmed by direct reproduction and a follow-up experiment: Nuxt 4's `shared/`
> directory is auto-imported into *both* client and server by Nuxt's own convention, so
> Vite must resolve and validate `movieCache.ts`'s top-level `node:fs`/`node:path`
> imports for the client bundle regardless of any runtime guard at the call site - a
> guard doesn't help because the problem isn't reachability at runtime, it's static
> resolution at bundle time. The reliable fix: code that touches `node:fs` must live
> somewhere the client bundle never statically imports from at all. A Nitro server API
> route (`server/`) is exactly that - the client only ever reaches it over HTTP
> (`useFetch`), never via a bundled `import`.
>
> This also means the two `shared/utils/movieCache.ts` functions that touch `node:fs`
> (`loadMovieCache`, `saveMovieCache`) need to move out of `shared/utils/` into
> `server/utils/`. The rest of `shared/utils/movieCache.ts` (`CachedMovie`,
> `MovieCache`, `MOVIE_CACHE_PATH`, `CACHE_TTL_MS`, `FetchPlan`, `planMovieFetch`) has
> no Node-builtin imports and stays exactly where Task 1 put it - Task 2's
> `shared/utils/app.ts` (which only imports `planMovieFetch` and the `MovieCache` type,
> never the fs functions) needs no changes at all.

**Files:**
- Modify: `shared/utils/movieCache.ts` (remove the two fs-touching functions and their imports)
- Modify: `shared/utils/movieCache.test.ts` (remove the load/save tests - they move below)
- Create: `server/utils/movieCacheStorage.ts` (the fs-touching functions, relocated)
- Create: `server/utils/movieCacheStorage.test.ts` (the load/save tests, relocated)
- Create: `server/api/movies.get.ts` (GraphQL fetch + `processData` + cache orchestration, relocated from `useMovies.ts`)
- Modify: `composables/useMovies.ts` (replace its whole body with a thin `useFetch` wrapper)

**Interfaces:**
- Consumes: `processData` (Task 2, requires a `cache` argument), `planMovieFetch`/`MovieCache`/`MOVIE_CACHE_PATH` (Task 1, unchanged location).
- Produces: `loadMovieCache(path: string): Promise<MovieCache>`, `saveMovieCache(path: string, cache: MovieCache): Promise<void>` (same signatures as Task 1 originally specified, just under `server/utils/movieCacheStorage.ts` now).

- [ ] **Step 1: Remove the fs-touching functions from `shared/utils/movieCache.ts`**

In `shared/utils/movieCache.ts`, change the top of the file from:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface CachedMovie {
```

to:

```ts
export interface CachedMovie {
```

Then delete the `loadMovieCache` and `saveMovieCache` functions entirely from the end of the file (everything from `export async function loadMovieCache` through the closing brace of `saveMovieCache`). `CachedMovie`, `MovieCache`, `MOVIE_CACHE_PATH`, `CACHE_TTL_MS`, `FetchPlan`, and `planMovieFetch` all stay, unchanged.

- [ ] **Step 2: Move the load/save tests out of `shared/utils/movieCache.test.ts`**

In `shared/utils/movieCache.test.ts`, delete the entire `describe("loadMovieCache / saveMovieCache", ...)` block and its now-unused imports (`mkdtempSync`, `rmSync`, `tmpdir`, `join`, `loadMovieCache`, `saveMovieCache` - keep the `planMovieFetch`/`CACHE_TTL_MS`/`CachedMovie` imports, since the `describe("planMovieFetch", ...)` block stays as-is).

- [ ] **Step 3: Run the remaining test to verify it still fails to compile (RED)**

Run: `bun test shared/utils/movieCache.test.ts`
Expected: passes (the `planMovieFetch` tests are untouched and don't reference the removed functions) - this step just confirms the file is self-consistent after deleting the load/save block.

- [ ] **Step 4: Create `server/utils/movieCacheStorage.test.ts` (failing)**

```ts
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMovieCache, saveMovieCache } from "./movieCacheStorage";
import type { CachedMovie } from "~/shared/utils/movieCache";

describe("loadMovieCache / saveMovieCache", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("loadMovieCache returns {} when the file doesn't exist", async () => {
    dir = mkdtempSync(join(tmpdir(), "movie-cache-test-"));
    const cache = await loadMovieCache(join(dir, "missing.json"));
    expect(cache).toEqual({});
  });

  test("loadMovieCache returns {} when the file has invalid JSON", async () => {
    dir = mkdtempSync(join(tmpdir(), "movie-cache-test-"));
    const path = join(dir, "corrupt.json");
    await Bun.write(path, "{ not valid json");
    const cache = await loadMovieCache(path);
    expect(cache).toEqual({});
  });

  test("saveMovieCache then loadMovieCache round-trips the data, creating missing directories", async () => {
    dir = mkdtempSync(join(tmpdir(), "movie-cache-test-"));
    const path = join(dir, "nested", "movie-cache.json");
    const data: Record<string, CachedMovie> = {
      "some-movie": {
        imdb_link: "tt1234567",
        imdb_rating: "8.1",
        poster: "https://example.com/p.jpg",
        release_date: "2026-01-01T00:00:00.000Z",
        display_release_date: "01 January 2026",
        cachedAt: "2026-07-30T00:00:00.000Z",
      },
    };

    await saveMovieCache(path, data);
    const loaded = await loadMovieCache(path);

    expect(loaded).toEqual(data);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `bun test server/utils/movieCacheStorage.test.ts`
Expected: FAIL - `./movieCacheStorage` module not found.

- [ ] **Step 6: Implement `server/utils/movieCacheStorage.ts`**

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MovieCache } from "~/shared/utils/movieCache";

export async function loadMovieCache(path: string): Promise<MovieCache> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as MovieCache) : {};
  } catch {
    return {};
  }
}

export async function saveMovieCache(path: string, cache: MovieCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cache, null, 2), "utf-8");
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `bun test server/utils/movieCacheStorage.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Create `server/api/movies.get.ts`**

This relocates the GraphQL fetch (previously in `useMovies.ts`) and adds the cache load/save around `processData`:

```ts
import { processData } from '~/shared/utils/app';
import { MOVIE_CACHE_PATH } from '~/shared/utils/movieCache';
import { loadMovieCache, saveMovieCache } from '~/server/utils/movieCacheStorage';
import type { Movie } from '~/shared/types/movie';

// api.kino.dk (the old Drupal-backed showtimes endpoint) is down; this hits
// the same GraphQL schedule API kino2 uses instead (see kino2/cinema-schedule.bru).
const GRAPHQL_ENDPOINT = 'https://kinodk-movieinfoqs.azurewebsites.net/graphql';

const QUERY = `
  query($locations: [String]) {
    movieQuery {
      getCurrentMovies(locations: $locations removePastShows: true) {
        title
        titleOriginal
        mainVersionId
        premiere
        productionYear
        nationalities
        lengthInMinutes
        sanityImagePosterUrl
        shows {
          theaterName
          theaterId
          showStart
          ticketSaleUrl
        }
      }
    }
  }
`;

export default defineEventHandler(async (): Promise<Movie[]> => {
  const config = useRuntimeConfig();
  try {
    const response = await fetch(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { locations: ['Aarhus', 'Trøjborg'] } })
    });
    const data = await response.json();

    const cache = await loadMovieCache(MOVIE_CACHE_PATH);
    const result = await processData(data, config.tmdbApiKey as string, cache);
    await saveMovieCache(MOVIE_CACHE_PATH, cache);
    return result;
  } catch (error) {
    console.error('Failed to fetch movies:', error);
    return [];
  }
});
```

- [ ] **Step 9: Replace `composables/useMovies.ts` with a thin wrapper**

Replace the entire file with:

```ts
import type { Movie } from '~/shared/types/movie';

export const useMovies = async () => {
  const { data: movies } = await useFetch<Movie[]>('/api/movies');
  return movies;
};
```

- [ ] **Step 10: Verify the app builds and the cache file gets created**

Run: `bun install` (if `node_modules` isn't already present), then `bun run generate`.

A `TMDB_READ_TOKEN` is already present in the repo's `.env`, which Nuxt loads automatically, so this is a real, fairly complete end-to-end run.

Expected:
- The build completes without errors, including the client build step (this is what proves the client Vite bundle has no `node:fs` reference this time - `server/api/*` and `server/utils/*` are Nitro-only and never enter that graph).
- A `.cache/movie-cache.json` file now exists at the project root with one entry per resolved/attempted movie.
- The generated pages (check `.output/public/index.html` or `.output/public/movies/*/index.html`) still contain real movie data - confirming `useFetch('/api/movies')` resolved the API route in-process during prerendering and embedded its result in each page's payload, the same way `useAsyncData` did before.
- Running `bun run generate` a second time completes with the same result, and most movies now hit the `'reuse'` plan (no new network calls for them) instead of `'resolve'`.

If the build fails again with a similar `node:fs` externalization error, stop and report BLOCKED with the exact error - do not attempt further architectural workarounds without checking in.

- [ ] **Step 11: Run the full test suite**

Run: `bun test`
Expected: PASS (Task 1's `planMovieFetch` tests, Task 2's `processData` tests, and this task's `movieCacheStorage` tests - all passing, no regressions).

- [ ] **Step 12: Commit**

```bash
git add shared/utils/movieCache.ts shared/utils/movieCache.test.ts server/utils/movieCacheStorage.ts server/utils/movieCacheStorage.test.ts server/api/movies.get.ts composables/useMovies.ts
git commit -m "fix: move the movie cache's filesystem access into a Nitro server route

The import.meta.server-guarded dynamic import approach didn't keep
node:fs out of the client Vite bundle in this Nuxt/Vite setup, because
shared/ is auto-imported into both client and server. Moving the fs
work behind a server API route (never reachable from client-bundled
code via import) fixes it by construction."
```

---

### Task 4: CI cache restore/save (`.github/workflows/nuxtjs.yml`)

**Files:**
- Modify: `.github/workflows/nuxtjs.yml`

**Interfaces:**
- None (workflow YAML only; no code interfaces).

- [ ] **Step 1: Add the cache-restore/save step**

In `.github/workflows/nuxtjs.yml`, in the `build` job, change:

```yaml
      - name: Install dependencies
        run: bun install
      - name: Static HTML export with Nuxt
        env:
          TMDB_READ_TOKEN: ${{ secrets.TMDB_READ_TOKEN }}
        run: bun run generate
```

to:

```yaml
      - name: Install dependencies
        run: bun install
      - name: Restore movie match cache
        uses: actions/cache@v4
        with:
          path: .cache
          key: movie-cache-${{ github.run_id }}
          restore-keys: |
            movie-cache-
      - name: Static HTML export with Nuxt
        env:
          TMDB_READ_TOKEN: ${{ secrets.TMDB_READ_TOKEN }}
        run: bun run generate
```

- [ ] **Step 2: Verify the workflow file is still valid YAML**

There's no local GitHub Actions runner in this repo, so this can't be executed end-to-end locally. At minimum, confirm the file still parses as YAML, e.g.:

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/nuxtjs.yml'))"`
Expected: no output (no exception raised).

If `python3`/`yaml` isn't available, visually double-check indentation matches the surrounding steps (2-space indents, `- name:` aligned with the other step entries), then proceed - full validation happens on the next push to `main`, where you should confirm in the Actions run log that "Restore movie match cache" shows a cache miss on the first run after this change, and a cache hit (via `restore-keys`) on the run after that.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/nuxtjs.yml
git commit -m "ci: restore and save the movie match cache across builds"
```

---

## Self-Review Notes

- **Spec coverage:** cache shape/key (Task 1), 7-day TTL refresh-only-rating-poster (Task 1 `planMovieFetch` + Task 2 `'refresh'` branch), cache-everything-including-no-result (Task 2 `'resolve'` branch always writes `cache[id]`), stale-fallback-on-refresh-failure (Task 2 `'refresh'` branch pre-applies stale values before awaiting), missing/corrupt cache treated as empty (`server/utils/movieCacheStorage.ts`, Task 3 revised), CI `actions/cache` wiring with run-id key + prefix restore (Task 4). The invalidate-cache workflow was already built during brainstorming and needs no further task.
- **Client bundle safety (revised during execution):** the original Task 3 approach (`import.meta.server` guard + dynamic import) was implemented and empirically failed - `bun run generate` broke with a Rollup export error because Nuxt's `shared/` directory is auto-imported into both client and server, so Vite resolves `node:fs` regardless of runtime guards. Fixed by relocating the two fs-touching functions to `server/utils/movieCacheStorage.ts` and the fetch+cache orchestration to `server/api/movies.get.ts` - both are Nitro-only, reachable from the client only over HTTP, never via a bundled `import`. See the note at the top of the revised Task 3.
- **Type consistency:** `MovieCache`/`CachedMovie` (Task 1, unchanged location) are the exact types consumed in Task 2's `processData` signature and in `server/utils/movieCacheStorage.ts`/`server/api/movies.get.ts` (Task 3, revised); `MovieEnrichmentDeps` (introduced Task 2) is used consistently in both the implementation and its tests; `MOVIE_CACHE_PATH` (Task 1) is the exact name imported in `server/api/movies.get.ts`.
- **No placeholders:** every step includes full, real code - no "similar to above" or "add error handling" stand-ins.
