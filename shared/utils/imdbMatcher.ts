// Resolves a Kino movie to its exact IMDb title (tt id).
// Title alone is ambiguous (remakes, multi-part films, localized titles) so
// candidates from THREE independent sources are pooled and scored on title
// similarity + release year (+/-1) + origin country + runtime + popularity:
//   - TMDB search/movie (+ movie details for country/runtime/imdb id)
//   - IMDb's own GraphQL API (api.graphql.imdb.com, mainSearch)
//   - IMDb's autocomplete suggestion API (v3.sg.media-imdb.com/suggestion)
// The suggestion API does its own alias/AKA resolution server-side (e.g.
// querying "Vaiana" surfaces "Moana"), which the other two sources don't do,
// but that means its title text won't literally match the Kino title -- so
// it gets a baseline "already relevant" credit instead of a text-similarity
// score, and leans on year/runtime/popularity to pick the right one among
// its (often several) results.
//
// A match is "high" confidence only when 2+ of the 3 sources land on the
// same tt id. Otherwise it's "medium" (one strong, unambiguous source) or
// "low" (weak or conflicting) and left unresolved by the caller.
//
// Note: api.graphql.imdb.com and the suggestion endpoint are undocumented
// internal IMDb APIs (used by imdb.com itself).

import { fetchParadisbioFacts } from "./paradisbio";
import { fetchWithRetry } from "./fetchRetry";

export interface KinoMovieInput {
  title: string;
  titleOriginal?: string;
  premiere?: string; // ISO date; unset/invalid means unknown
  productionYear?: string; // "" or "0" means unknown
  nationalities?: string[];
  lengthInMinutes?: number;
  /**
   * Number of scheduled showtimes for this listing. Kino sometimes reuses a
   * title record for a remake/sequel without updating its premiere date
   * (e.g. "Vaiana" kept the 2016 original's Danish premiere after being
   * reused for the 2026 live-action remake), which makes the year-match
   * below penalize the correct, current candidate. A schedule with dozens
   * of showtimes is unambiguously a new wide release rather than a one-off
   * rerun (verified: real cinematheque/classic reruns in this data source
   * have exactly 1 showtime), so it's used to trust a candidate's own
   * recency over Kino's own possibly-stale year field -- see scoreCandidate.
   */
  showCount?: number;
}

export interface ImdbMatch {
  imdbId: string;
  confidence: "high" | "medium" | "low";
  score: number;
  margin: number;
  agreement: boolean; // did 2+ sources land on the same tt id?
  candidateTitle: string;
  candidateOriginalTitle: string;
  candidateYear: string;
  source: string; // e.g. "tmdb", "imdb+suggest"
  /** Set when the top two distinct tt id candidates are both plausible. */
  conflict?: { primaryId: string; primarySource: string; alternateId: string; alternateSource: string };
  /** Set when a venue-site scrape (e.g. paradisbio.dk) or a title-stripping retry supplied the winning signal. */
  enrichedFrom?: string;
  /**
   * Poster from TMDB's own listing for the winning title, captured directly
   * from the title-search hit during matching. TMDB doesn't always cross-
   * link its entry to the IMDb id (small/new titles especially), which makes
   * looking posters up *by* IMDb id come back empty even though TMDB has the
   * movie -- this gives callers a poster to fall back to in that case.
   */
  tmdbPosterUrl?: string;
}

export interface Candidate {
  imdbId: string | null;
  title: string;
  originalTitle: string;
  year: number | null;
  countries: string[]; // normalized country names
  runtimeMinutes: number | null;
  typeText: string | null; // e.g. "Movie", "TV Episode"
  popularityRank?: number | null; // lower = more popular (suggestion API only)
  titleAlreadyRelevant?: boolean; // true when the source already did alias/AKA matching
  posterPath?: string | null; // TMDB poster_path, only ever set by the tmdb source
  /**
   * The candidate's own Danish release/AKA title(s) (TMDB's per-country
   * alternative_titles, only ever set by the tmdb source). Kino's title is
   * usually the actual Danish title, not the English one -- e.g. "Shaun the
   * Sheep Movie" released in Denmark as "F for Får" -- so without this, a
   * correct match can only be inferred indirectly (year/type/popularity
   * bonuses covering for near-zero text similarity against the English
   * title). Scoring against the real Danish title directly turns that into
   * a genuine, verifiable text match instead of a trust-the-source guess.
   */
  akaTitles?: string[];
  /**
   * How many people have rated this title on IMDb, when the source that
   * found it reports one (currently tmdb and imdb; the lightweight suggest
   * API doesn't carry it). Used to tell a real, if brand-new or obscure,
   * film apart from a coincidental exact-title match to something IMDb's own
   * search/autocomplete surfaced but nothing else corroborates -- see
   * isCorroborated.
   */
  voteCount?: number | null;
}

export type SourceName = "tmdb" | "imdb" | "suggest";

const COUNTRY_ALIASES: Record<string, string> = {
  usa: "united states",
  us: "united states",
  "united states": "united states",
  "united states of america": "united states",
  uk: "united kingdom",
  "great britain": "united kingdom",
  storbritannien: "united kingdom",
  danmark: "denmark",
  tyskland: "germany",
  frankrig: "france",
  sverige: "sweden",
  norge: "norway",
  sydkorea: "south korea",
  "south korea": "south korea",
  rusland: "russia",
  russia: "russia",
  "russian federation": "russia",
  kina: "china",
  italien: "italy",
  spanien: "spain",
  belgien: "belgium",
  holland: "netherlands",
  nederlandene: "netherlands",
  indien: "india",
  australien: "australia",
  østrig: "austria",
  polen: "poland",
  schweiz: "switzerland",
  irland: "ireland",
  grækenland: "greece",
  tjekkiet: "czech republic",
  "czech republic": "czech republic",
  ungarn: "hungary",
  island: "iceland",
  brasilien: "brazil",
  sydafrika: "south africa",
  japan: "japan",
};

function normalizeCountry(name: string): string {
  const lower = name.trim().toLowerCase();
  return COUNTRY_ALIASES[lower] ?? lower;
}

export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    // Danish/Norwegian æ, ø, å are distinct letters, not base+diacritic, so
    // NFKD doesn't decompose them the way it does é/ö/ñ -- without this they
    // fall through to the "strip anything non-alphanumeric" step below and
    // become word-breaking spaces instead of the letters they stand for
    // (e.g. "Troløs" -> "trol s" instead of "trolos"), which silently zeroes
    // out title-similarity against any transliterated/foreign spelling.
    // å specifically transliterates to "aa", not "a" -- its official
    // pre-1948 spelling and still how proper nouns are anglicized today
    // (Århus/Aarhus, Håkon/Haakon). A bare "a" is wrong on both counts: it
    // doesn't match that real convention, and it collapses an unrelated
    // word into a real one -- "får" (sheep) normalizing to "far" (dad)
    // wrongly exact-matched a Kino listing to an unrelated film called
    // "F for Far".
    .replace(/æ/g, "ae")
    .replace(/ø/g, "o")
    .replace(/å/g, "aa")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const wa = na.split(" ").filter(Boolean);
  const wb = nb.split(" ").filter(Boolean);
  const ta = new Set(wa);
  const tb = new Set(wb);

  // Whole-word containment: every word of the shorter title appears as a
  // whole word in the longer one (avoids e.g. "Enzo" matching "Enzo9000").
  const [shorter, longer] = wa.length <= wb.length ? [ta, tb] : [tb, ta];
  if (shorter.size > 0 && [...shorter].every((w) => longer.has(w))) return 0.8;

  const inter = wa.filter((w) => tb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union === 0 ? 0 : inter / union;
}

const TRAILING_YEAR = /\s*\((\d{4})\)\s*$/;

/**
 * Splits a trailing "(YYYY)" annotation off a title, e.g. Kino listing
 * classic reruns as "Bjergkøbing Grand Prix (1975)". Returns the title with
 * the annotation removed, and the year if it's in a plausible release-year
 * range (guards against e.g. "Room 1408" or other incidental 4-digit
 * parentheticals that aren't actually a year).
 */
function splitTrailingYear(title: string): { stripped: string; year: number | null } {
  const m = title.match(TRAILING_YEAR);
  if (!m) return { stripped: title, year: null };
  const year = parseInt(m[1]!, 10);
  if (year < 1888 || year > new Date().getFullYear() + 2) return { stripped: title, year: null };
  return { stripped: title.slice(0, m.index).trim(), year };
}

// Kino's premiere/productionYear fields use a "0001-01-01" sentinel for an
// unknown date, which parses to literal year 1 via Date and -- left
// unchecked -- reads as a real year, wrongly penalizing a correct
// candidate's real release year in scoreCandidate (and, symmetrically,
// wrongly rewarding a wrong candidate that simply has no year data on
// IMDb to compare against). No real theatrical release predates 1920, so
// anything under that is treated as "no year data" rather than a bogus one.
const MIN_PLAUSIBLE_KINO_YEAR = 1920;

function kinoYear(movie: KinoMovieInput): number | null {
  if (movie.productionYear && /^\d{4}$/.test(movie.productionYear)) {
    const year = parseInt(movie.productionYear, 10);
    return year >= MIN_PLAUSIBLE_KINO_YEAR ? year : null;
  }
  if (movie.premiere) {
    const year = new Date(movie.premiere).getFullYear();
    if (!Number.isNaN(year) && year >= MIN_PLAUSIBLE_KINO_YEAR) return year;
  }
  return null;
}

function popularityBonus(rank: number | null | undefined): number {
  if (rank == null) return 0;
  if (rank <= 300) return 8;
  if (rank <= 3000) return 5;
  if (rank <= 30000) return 2;
  return 0;
}

// "Short" is included here too: a bare short film is rarely what's actually
// programmed under its own listing at a cinema, but its title is often a
// generic/common phrase (more collision-prone than a feature's) -- without
// this, a short that happens to share a Kino title's exact string can hit a
// "perfect" title-similarity score and win purely on a coincidence, crowding
// out the real (often less literally-matching, e.g. foreign-titled) feature
// before enrichment fallbacks in resolveImdbId even get a chance to run.
const NON_THEATRICAL_TYPES = new Set(["TV Episode", "TV Series", "Video", "Podcast Episode", "Podcast Series", "Video Game", "Music Video", "Short"]);

// Below this many scheduled showtimes, a listing could plausibly be a
// one-off cinematheque/classic rerun (verified: real reruns in this data
// source have exactly 1 showtime) where Kino's year field, however old, is
// legitimately correct. At or above it, a schedule this size is
// unambiguously a new wide release.
const WIDE_RELEASE_SHOW_THRESHOLD = 20;

// Every title string worth comparing Kino's listing against: its raw
// title/titleOriginal plus every event/version-framing and
// parenthetical-original-title variant nested inside each (see
// extractCandidateTitles) -- e.g. "Soudain (All of a Sudden)" also compares
// as "Soudain" and "All of a Sudden" individually, since a candidate may
// only carry one of the three forms.
function kinoTitleVariants(movie: Pick<KinoMovieInput, "title" | "titleOriginal">): string[] {
  const rawKinoTitles = [movie.title, movie.titleOriginal].filter((t): t is string => !!t);
  return [...new Set([...rawKinoTitles, ...rawKinoTitles.flatMap(extractCandidateTitles)])];
}

// Every plausible release year Kino's listing gives us for this title: its
// own premiere/productionYear field (see kinoYear) plus any "(YYYY)"
// annotation baked into the title or titleOriginal strings themselves (see
// splitTrailingYear) -- either source can be the trustworthy one depending
// on the listing, so both are offered up rather than picking one.
function movieYearCandidates(movie: KinoMovieInput): number[] {
  const rawKinoTitles = [movie.title, movie.titleOriginal].filter((t): t is string => !!t);
  const titleAnnotations = rawKinoTitles.map(splitTrailingYear);
  return [...new Set([kinoYear(movie), ...titleAnnotations.map((t) => t.year)].filter((y): y is number => y !== null))];
}

export type ExactMatchTier = 1 | 2 | 3;

function matchesExactly(titles: string[], candidateTitle: string): boolean {
  return titles.some((t) => titleSimilarity(t, candidateTitle) === 1);
}

/**
 * How strongly a candidate's own title text matches Kino's listing, as a
 * strict priority ladder rather than a fuzzy score:
 *   1. Exact title match (candidate.title or .originalTitle) with a release
 *      year within 1 of one Kino gives us.
 *   2. Exact match against Kino's raw, unmodified title/titleOriginal (not
 *      one of the event/version-framing or original-title fragments split
 *      out of it -- see extractCandidateTitles) despite a mismatched year --
 *      catches re-releases whose Danish premiere is years after the film's
 *      own release, however large that gap is: a real re-release can be any
 *      age (7 years or 50), so there's no sound cutoff to tune here.
 *   3. No exact match on the primary title, but an exact match against the
 *      candidate's own Danish AKA title (see Candidate.akaTitles).
 *   null otherwise -- including an exact match that only exists because WE
 *   split Kino's title into a fragment (e.g. "Dune" out of "Dune: Del 3")
 *   despite a mismatched year. That distinction matters: Kino's raw title,
 *   or the candidate's own official AKA, coinciding exactly with an
 *   unrelated film is astronomically unlikely regardless of the year gap --
 *   but a single reused franchise word is not (e.g. "Dune" (1984)
 *   exact-matching "Dune: Del 3"'s "Dune" fragment, when the real match is
 *   the textually-unrelated "Dune: Part Three"), so a fragment-only match is
 *   trusted only when the year actually corroborates it (tier 1), leaving
 *   the rest to the year-aware fuzzy fallback, which already scores "just a
 *   different, unrelated film" down correctly via its own year penalty.
 * "Exact" here is strict string equality after normalization (titleSimilarity
 * === 1) -- the word-containment shortcut that gives partial credit for e.g.
 * "Avengers" inside "Avengers: Doomsday" does NOT qualify. That distinction
 * matters: Kino's re-release premiere for "Avengers: Endgame" can read as a
 * future year that coincidentally matches an unrelated, currently-hyped
 * "Avengers: Doomsday", which only ever share the bare franchise word, never
 * the full title -- so it's disqualified from every tier here, however
 * strong that partial similarity looks to the fuzzy scoreCandidate below.
 */
export function classifyExactMatchTier(movie: KinoMovieInput, candidate: Candidate): ExactMatchTier | null {
  const rawKinoTitles = [movie.title, movie.titleOriginal].filter((t): t is string => !!t);
  const kinoTitles = kinoTitleVariants(movie);

  const exactOnRaw = matchesExactly(rawKinoTitles, candidate.title) || matchesExactly(rawKinoTitles, candidate.originalTitle);
  const exactOnAny = exactOnRaw || matchesExactly(kinoTitles, candidate.title) || matchesExactly(kinoTitles, candidate.originalTitle);
  const akaExact = (candidate.akaTitles ?? []).some((aka) => matchesExactly(kinoTitles, aka));

  if (!exactOnAny && !akaExact) return null;

  const yearCandidates = movieYearCandidates(movie);
  const yearMatch = candidate.year !== null && yearCandidates.some((y) => Math.abs(y - candidate.year!) <= 1);
  if (exactOnAny && yearMatch) return 1;

  if (exactOnRaw) return 2;
  if (akaExact) return 3;
  return null;
}

function scoreCandidate(movie: KinoMovieInput, candidate: Candidate): number {
  let score = 0;

  // Score against the raw title (with its "(YYYY)" annotation, if any) and
  // every event/version-framing and parenthetical-original-title variant
  // extracted from it (see extractCandidateTitles), and let the best-scoring
  // one win -- e.g. "Soudain (All of a Sudden)" needs to be scored against
  // "All of a Sudden" on its own to land a clean similarity match, not just
  // against the combined string; keeping the raw string too means stripping
  // it unconditionally is never required for a title that already matches
  // as-is.
  const kinoTitles = kinoTitleVariants(movie);
  // Kino's title is usually the Danish release title, not the English or
  // original-language one, so a candidate's Danish AKA (see akaTitles) is
  // included here too -- without it, a correct match with a very different
  // Danish title (e.g. "Shaun the Sheep Movie" / "F for Får") can only be
  // inferred indirectly via year/type/popularity bonuses instead of a real
  // text match.
  const candidateTitles = [candidate.title, candidate.originalTitle, ...(candidate.akaTitles ?? [])].filter((t): t is string => !!t);
  const titleScores = kinoTitles.flatMap((kt) => candidateTitles.map((ct) => titleSimilarity(kt, ct)));
  const maxTitleScore = Math.max(0, ...titleScores);
  let titleComponent = maxTitleScore * 40;
  if (candidate.titleAlreadyRelevant) titleComponent = Math.max(titleComponent, 22);
  score += titleComponent;

  // Same principle for year: Kino's premiere/productionYear fields can be
  // stale (e.g. a rerun keeps an old listing's date) while a "(YYYY)"
  // annotation baked into the title itself is sometimes the trustworthy one
  // (or vice versa) -- try every year Kino gives us for this title and keep
  // whichever produces the best-scoring match against the candidate, rather
  // than hard-coding which source to trust.
  const yearCandidates = movieYearCandidates(movie);
  const isWideRelease = (movie.showCount ?? 0) >= WIDE_RELEASE_SHOW_THRESHOLD;
  const isCurrentRelease = candidate.year !== null && Math.abs(candidate.year - new Date().getFullYear()) <= 1;

  if (isWideRelease && isCurrentRelease) {
    // Kino's own premiere/year field is stale for this title (reused from
    // an earlier release under the same name) -- trust the candidate's own
    // recency over it, same weight as a genuine exact year match.
    score += 30;
  } else if (yearCandidates.length > 0 && candidate.year !== null) {
    const yearScores = yearCandidates.map((y) => {
      const diff = Math.abs(y - candidate.year!);
      if (diff === 0) return 30;
      if (diff === 1) return 18;
      return -20;
    });
    score += Math.max(...yearScores);
  }

  if (movie.nationalities?.length && candidate.countries.length) {
    const kinoCountries = new Set(movie.nationalities.map(normalizeCountry));
    const candidateCountries = new Set(candidate.countries.map(normalizeCountry));
    const intersects = [...kinoCountries].some((c) => candidateCountries.has(c));
    score += intersects ? 20 : -15;
  }

  if (movie.lengthInMinutes && candidate.runtimeMinutes) {
    const diff = Math.abs(movie.lengthInMinutes - candidate.runtimeMinutes);
    if (diff <= 3) score += 10;
    else if (diff <= 7) score += 5;
    else if (diff > 20) score -= 10;
  }

  if (candidate.typeText === "Movie") score += 8;
  else if (candidate.typeText && NON_THEATRICAL_TYPES.has(candidate.typeText)) {
    // The penalty exists to stop a short that merely *shares* a title
    // string from crowding out the real feature (see comment above). That
    // rationale doesn't apply when it's Kino's own title matching exactly --
    // there's no coincidence left to guard against, so a genuine short being
    // screened under its own name isn't docked for being a short.
    if (!(candidate.typeText === "Short" && maxTitleScore === 1)) score -= 25;
  }

  score += popularityBonus(candidate.popularityRank);

  return score;
}

// Every distinct title string worth firing at a title-search API for one
// Kino listing: its raw title/titleOriginal plus every event/version-framing
// and parenthetical-original-title variant nested inside each (see
// extractCandidateTitles) -- e.g. "Soudain (All of a Sudden)" also searches
// "Soudain" and "All of a Sudden" individually, since a catalog may only
// recognize one of the three forms.
function candidateSearchTitles(movie: KinoMovieInput): string[] {
  const bases = [movie.titleOriginal, movie.title].filter((t): t is string => !!t);
  const all = new Set<string>();
  for (const base of bases) for (const variant of extractCandidateTitles(base)) all.add(variant);
  return [...all];
}

// ---- TMDB source ----

const TMDB_BASE = "https://api.themoviedb.org/3";

interface TmdbSearchResult {
  id: number;
  title: string;
  original_title: string;
  release_date: string;
}

interface TmdbMovieDetails {
  id: number;
  title: string;
  original_title: string;
  release_date: string;
  runtime: number;
  poster_path: string | null;
  production_countries: Array<{ iso_3166_1: string; name: string }>;
  external_ids: { imdb_id: string | null };
  alternative_titles: { titles: Array<{ iso_3166_1: string; title: string }> };
}

function tmdbHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function tmdbSearch(token: string, query: string, year?: string): Promise<TmdbSearchResult[]> {
  const params = new URLSearchParams({ query, include_adult: "false", language: "en-US" });
  if (year) params.set("primary_release_year", year);
  const res = await fetchWithRetry(`${TMDB_BASE}/search/movie?${params}`, { headers: tmdbHeaders(token) });
  if (!res.ok) throw new Error(`TMDB search failed: ${res.status}`);
  return (await res.json()).results as TmdbSearchResult[];
}

async function tmdbDetails(token: string, id: number): Promise<TmdbMovieDetails> {
  // alternative_titles is appended alongside external_ids on the same
  // request (no extra round-trip) so the Danish AKA title is available for
  // scoring wherever a candidate's title is compared against Kino's.
  const res = await fetchWithRetry(`${TMDB_BASE}/movie/${id}?append_to_response=external_ids,alternative_titles&language=en-US`, {
    headers: tmdbHeaders(token),
  });
  if (!res.ok) throw new Error(`TMDB details failed: ${res.status}`);
  return res.json() as Promise<TmdbMovieDetails>;
}

async function tmdbCandidates(movie: KinoMovieInput, token: string): Promise<Candidate[]> {
  if (!token) return [];
  const year = kinoYear(movie);
  const queries = candidateSearchTitles(movie);

  const collect = async (withYear: boolean) => {
    const seen = new Map<number, TmdbSearchResult>();
    const batches = await Promise.all(
      queries.map((q) => tmdbSearch(token, q, withYear && year ? String(year) : undefined).catch(() => []))
    );
    for (const batch of batches) for (const r of batch) if (!seen.has(r.id)) seen.set(r.id, r);
    return [...seen.values()];
  };

  // Always query both with Kino's year (when known) and without it, and keep
  // up to 6 results from each independently -- TMDB's own primary_release_year
  // filter can silently exclude the correct match server side when Kino's
  // year is wrong (e.g. a re-release's screening date misread as the film's
  // year), and if the year-filtered pass alone already fills a combined
  // top-N cut, the unfiltered pass's results -- including the real match --
  // never get a chance to be seen at all.
  const withYear = year ? await collect(true) : [];
  const dateless = await collect(false);
  const top = new Map<number, TmdbSearchResult>();
  for (const r of [...withYear.slice(0, 6), ...dateless.slice(0, 6)]) top.set(r.id, r);

  const details = await Promise.all([...top.values()].map((c) => tmdbDetails(token, c.id).catch(() => null)));

  return details.filter((d): d is TmdbMovieDetails => d !== null).map((d) => ({
    imdbId: d.external_ids.imdb_id,
    title: d.title,
    originalTitle: d.original_title,
    year: d.release_date ? new Date(d.release_date).getFullYear() : null,
    countries: d.production_countries.map((c) => c.name),
    runtimeMinutes: d.runtime || null,
    // TMDB's /search/movie catalog isn't purely theatrical features -- it
    // also surfaces direct-to-video/obscure B-catalog titles that IMDb
    // itself classifies as e.g. "Video", not "Movie" (verified: TMDB's own
    // `video` flag doesn't reliably flag these either). Crediting every hit
    // here as a confirmed theatrical movie let one such title win purely on
    // an unearned +8, so leave it unknown/neutral and let the other,
    // correctly-labeled sources supply the type signal.
    typeText: null,
    posterPath: d.poster_path,
    akaTitles: d.alternative_titles.titles.filter((t) => t.iso_3166_1 === "DK").map((t) => t.title),
  }));
}

// A TMDB search hit whose title/year clearly matches the winning candidate,
// but whose own external_ids.imdb_id is null (TMDB hasn't cross-linked it
// yet) is dropped from scoring entirely (scoreAll requires an imdbId to
// pool by) -- so it never gets a chance to win findImdbId on its own merits.
// This recovers its poster anyway by re-checking title/year similarity
// against whichever id *did* win, independent of the id-resolution result.
function findTmdbPosterFor(tmdbCands: Candidate[], target: { title: string; year: number | null }): string | undefined {
  let best: { posterPath: string; score: number } | null = null;
  for (const c of tmdbCands) {
    if (!c.posterPath) continue;
    const sim = Math.max(titleSimilarity(target.title, c.title), titleSimilarity(target.title, c.originalTitle), ...(c.akaTitles ?? []).map((t) => titleSimilarity(target.title, t)));
    if (sim < 0.8) continue;
    if (target.year !== null && c.year !== null && Math.abs(target.year - c.year) > 1) continue;
    if (!best || sim > best.score) best = { posterPath: c.posterPath, score: sim };
  }
  return best ? `https://image.tmdb.org/t/p/w500${best.posterPath}` : undefined;
}

// ---- IMDb GraphQL source (api.graphql.imdb.com, undocumented) ----

const IMDB_GRAPHQL_ENDPOINT = "https://api.graphql.imdb.com/";

const IMDB_SEARCH_QUERY = `
  query Search($term: String!) {
    mainSearch(first: 8, options: { searchTerm: $term, type: TITLE, includeAdult: true }) {
      edges {
        node {
          entity {
            ... on Title {
              id
              titleText { text }
              originalTitleText { text }
              titleType { text }
              releaseYear { year }
              countriesOfOrigin { countries { text } }
              runtime { seconds }
              ratingsSummary { voteCount }
            }
          }
        }
      }
    }
  }
`;

interface ImdbSearchEntity {
  id: string;
  titleText: { text: string } | null;
  originalTitleText: { text: string } | null;
  titleType: { text: string } | null;
  releaseYear: { year: number } | null;
  countriesOfOrigin: { countries: Array<{ text: string }> } | null;
  runtime: { seconds: number } | null;
  ratingsSummary: { voteCount: number } | null;
}

async function imdbGraphqlSearch(term: string): Promise<ImdbSearchEntity[]> {
  const res = await fetchWithRetry(IMDB_GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Same 403-without-Referer behavior as shared/utils/imdb.ts -- see comment there.
      "Referer": "https://www.imdb.com/",
      "Origin": "https://www.imdb.com",
    },
    body: JSON.stringify({ operationName: "Search", query: IMDB_SEARCH_QUERY, variables: { term } }),
  });
  if (!res.ok) throw new Error(`IMDb search failed: ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`IMDb search error: ${json.errors[0]?.message}`);
  return (json.data?.mainSearch?.edges ?? []).map((e: { node: { entity: ImdbSearchEntity } }) => e.node.entity);
}

async function imdbGraphqlCandidates(movie: KinoMovieInput): Promise<Candidate[]> {
  const queries = candidateSearchTitles(movie);
  const seen = new Map<string, ImdbSearchEntity>();
  const batches = await Promise.all(queries.map((q) => imdbGraphqlSearch(q).catch(() => [])));
  for (const batch of batches) for (const e of batch) seen.set(e.id, e);

  return [...seen.values()].map((e) => ({
    imdbId: e.id,
    title: e.titleText?.text ?? "",
    originalTitle: e.originalTitleText?.text ?? "",
    year: e.releaseYear?.year ?? null,
    countries: e.countriesOfOrigin?.countries.map((c) => c.text) ?? [],
    runtimeMinutes: e.runtime ? Math.round(e.runtime.seconds / 60) : null,
    typeText: e.titleType?.text ?? null,
    voteCount: e.ratingsSummary?.voteCount ?? null,
  }));
}

// ---- IMDb suggestion source (v3.sg.media-imdb.com, undocumented) ----
// This is the autocomplete backend behind imdb.com's search box. It resolves
// localized/AKA titles server-side (e.g. "Vaiana" -> "Moana") and returns a
// popularity `rank`, but no country/runtime data.

const IMDB_SUGGEST_ENDPOINT = "https://v3.sg.media-imdb.com/suggestion/x";

const SUGGEST_QID_TO_TYPE: Record<string, string> = {
  movie: "Movie",
  tvMovie: "TV Movie",
  tvSpecial: "TV Special",
  short: "Short",
  tvSeries: "TV Series",
  tvEpisode: "TV Episode",
  tvMiniSeries: "TV Mini Series",
  video: "Video",
  videoGame: "Video Game",
  podcastSeries: "Podcast Series",
  podcastEpisode: "Podcast Episode",
  musicVideo: "Music Video",
};

interface SuggestEntity {
  id: string;
  l?: string; // matched/display title (may be an AKA, e.g. query "Vaiana" -> "Moana")
  y?: number; // year
  qid?: string; // content type
  rank?: number; // popularity rank, lower = more popular
}

async function imdbSuggest(term: string): Promise<SuggestEntity[]> {
  const url = `${IMDB_SUGGEST_ENDPOINT}/${encodeURIComponent(term.trim())}.json?includeVideos=0`;
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`IMDb suggest failed: ${res.status}`);
  const json = await res.json();
  return (json.d ?? []) as SuggestEntity[];
}

async function suggestCandidates(movie: KinoMovieInput): Promise<Candidate[]> {
  const queries = candidateSearchTitles(movie);
  const seen = new Map<string, SuggestEntity>();
  const batches = await Promise.all(queries.map((q) => imdbSuggest(q).catch(() => [])));
  for (const batch of batches) for (const e of batch) if (/^tt\d+$/.test(e.id)) seen.set(e.id, e);

  return [...seen.values()].map((e) => ({
    imdbId: e.id,
    title: e.l ?? "",
    originalTitle: e.l ?? "",
    year: e.y ?? null,
    countries: [],
    runtimeMinutes: null,
    typeText: e.qid ? SUGGEST_QID_TO_TYPE[e.qid] ?? null : null,
    popularityRank: e.rank ?? null,
    titleAlreadyRelevant: true,
  }));
}

// ---- Orchestration: pool all sources, require corroboration ----

function scoreAll(movie: KinoMovieInput, candidates: Candidate[], source: SourceName) {
  return candidates
    .filter((c) => c.imdbId)
    .map((candidate) => ({ source, candidate, score: scoreCandidate(movie, candidate), tier: classifyExactMatchTier(movie, candidate) }));
}

type ScoredEntry = { id: string; candidate: Candidate; rawScore: number; sources: Set<SourceName>; tier: ExactMatchTier | null; voteCount: number | null };

/**
 * Whether a tier match (see classifyExactMatchTier) has enough independent
 * backing to trust at "high" confidence. Tier 1 already has a matching year
 * from Kino's own, separate data, so any 2-of-3 source agreement is real
 * corroboration. Tiers 2/3 trust an exact match with no year backing at all,
 * so they need a real second opinion beyond just 2 sources: either TMDB (a
 * genuinely independent database from IMDb's own search+autocomplete), or
 * the candidate having actual IMDb votes -- some real-world evidence it's a
 * known film, not just something IMDb's own search surfaced that nothing
 * else can confirm (e.g. Kino's "Filmquiz", a pub-quiz night that
 * coincidentally shares its name with an obscure, 0-vote 1991 film only
 * IMDb's own endpoints "agreed" on).
 */
export function isCorroborated(tier: ExactMatchTier, sources: Set<SourceName>, voteCount: number | null | undefined): boolean {
  if (sources.size < 2) return false;
  if (tier === 1) return true;
  return sources.has("tmdb") || (voteCount ?? 0) > 0;
}

function buildMatch(best: ScoredEntry, second: ScoredEntry | undefined, confidence: ImdbMatch["confidence"], tmdbCands: Candidate[]): ImdbMatch {
  const margin = second ? best.rawScore - second.rawScore : best.rawScore;
  const sourceLabel = [...best.sources].join("+");

  const conflict =
    confidence !== "high" && second && second.rawScore >= 35
      ? {
          primaryId: best.id,
          primarySource: sourceLabel,
          alternateId: second.id,
          alternateSource: [...second.sources].join("+"),
        }
      : undefined;

  // The winning id may have come from imdb/suggest alone while a TMDB search
  // hit for the same title/year exists but sits on the sidelines because its
  // own imdb_id cross-link is null -- recover its poster independently of
  // which source actually won the id.
  const tmdbPosterUrl = findTmdbPosterFor(tmdbCands, { title: best.candidate.title, year: best.candidate.year });

  return {
    imdbId: best.id,
    confidence,
    score: Math.round(best.rawScore * 10) / 10,
    margin: Math.round(margin * 10) / 10,
    agreement: confidence === "high",
    candidateTitle: best.candidate.title,
    candidateOriginalTitle: best.candidate.originalTitle,
    candidateYear: String(best.candidate.year ?? ""),
    source: sourceLabel,
    conflict,
    tmdbPosterUrl,
  };
}

export async function findImdbId(movie: KinoMovieInput, tmdbToken: string): Promise<ImdbMatch | null> {
  if (!movie.title) return null;

  const [tmdbCands, imdbCands, suggestCands] = await Promise.all([
    tmdbCandidates(movie, tmdbToken).catch(() => []),
    imdbGraphqlCandidates(movie).catch(() => []),
    suggestCandidates(movie).catch(() => []),
  ]);

  const all = [
    ...scoreAll(movie, tmdbCands, "tmdb"),
    ...scoreAll(movie, imdbCands, "imdb"),
    ...scoreAll(movie, suggestCands, "suggest"),
  ];
  if (all.length === 0) return null;

  const byId = new Map<string, { bestScore: number; bestCandidate: Candidate; sources: Set<SourceName>; bestTier: ExactMatchTier | null; bestVoteCount: number | null }>();
  for (const { source, candidate, score, tier } of all) {
    const id = candidate.imdbId!;
    const entry = byId.get(id);
    const voteCount = candidate.voteCount ?? null;
    if (!entry) {
      byId.set(id, { bestScore: score, bestCandidate: candidate, sources: new Set([source]), bestTier: tier, bestVoteCount: voteCount });
    } else {
      entry.sources.add(source);
      if (score > entry.bestScore) {
        entry.bestScore = score;
        entry.bestCandidate = candidate;
      }
      if (tier !== null && (entry.bestTier === null || tier < entry.bestTier)) entry.bestTier = tier;
      if (voteCount !== null && (entry.bestVoteCount === null || voteCount > entry.bestVoteCount)) entry.bestVoteCount = voteCount;
    }
  }

  const entries: ScoredEntry[] = [...byId.entries()].map(([id, e]) => ({
    id,
    candidate: e.bestCandidate,
    rawScore: e.bestScore,
    sources: e.sources,
    tier: e.bestTier,
    voteCount: e.bestVoteCount,
  }));
  const byRaw = [...entries].sort((a, b) => b.rawScore - a.rawScore);

  // "High" confidence via an exact-title tier, tried strictest first: title +
  // release date, then title alone, then Danish AKA title (see
  // classifyExactMatchTier), each requiring the appropriate corroboration
  // (see isCorroborated) -- within a tier, scoreCandidate is only ever used
  // to break ties between multiple candidates that both reached it, never to
  // gate whether the tier counts. A franchise-word / stale-year collision
  // (e.g. Kino's re-release-premiere year for "Avengers: Endgame"
  // coincidentally matching "Avengers: Doomsday"'s real year) never earns an
  // exact-title tier, so it can't win here even with full 3-source agreement
  // -- it falls through to the fuzzy ranking below, which still favors the
  // exact-title candidate on text similarity alone.
  //
  // Tier 1 falls through to a later tier or the fuzzy fallback when it isn't
  // corroborated, same as before. Tiers 2/3 don't: an exact match with no
  // year backing that also fails their (weaker-evidence) corroboration bar
  // is still very likely the right answer -- it's the only exact match found
  // -- but the fuzzy fallback isn't a safer bet either. It can confidently
  // resolve a colon-extracted fragment (e.g. "Let It Snow") to a completely
  // different, well-evidenced real film instead of leaving things alone. So
  // an uncorroborated tier 2/3 match is reported honestly as low confidence
  // and returned as-is, rather than risking a worse, differently-wrong
  // answer from the fuzzy fallback.
  for (const tier of [1, 2, 3] as const) {
    const atTier = entries.filter((e) => e.tier === tier).sort((a, b) => b.rawScore - a.rawScore);
    if (atTier.length === 0) continue;
    const best = atTier[0]!;
    const second = byRaw.find((e) => e.id !== best.id);
    if (isCorroborated(tier, best.sources, best.voteCount)) return buildMatch(best, second, "high", tmdbCands);
    if (tier === 1) continue;
    return buildMatch(best, second, "low", tmdbCands);
  }

  // No corroborated exact-title match at any tier -- fall back to the fuzzy
  // score + source-agreement ranking. "High" here requires 2+ independently-
  // queried sources to land on the same tt id AND that id to already have a
  // credible score on its own merits -- otherwise two engines sharing the
  // same blind spot (e.g. both mangling a special character the same way)
  // can "agree" on a wrong answer. Corroboration only ever promotes to high;
  // it never influences the ranking, so it can't bury a stronger
  // single-source exact match under a weak coincidental agreement.
  const agreed = entries.filter((e) => e.sources.size >= 2 && e.rawScore >= 40).sort((a, b) => b.rawScore - a.rawScore);

  let confidence: ImdbMatch["confidence"];
  let best: ScoredEntry;
  let second: ScoredEntry | undefined;

  if (agreed.length > 0) {
    confidence = "high";
    best = agreed[0]!;
    second = byRaw.find((e) => e.id !== best.id);
  } else {
    best = byRaw[0]!;
    second = byRaw[1];
    const margin = second ? best.rawScore - second.rawScore : best.rawScore;
    confidence = best.rawScore >= 65 && margin >= 20 ? "medium" : "low";
  }

  return buildMatch(best, second, confidence, tmdbCands);
}

function mergeWithParadisbio(movie: KinoMovieInput, facts: { originalTitle: string | null; country: string | null; year: number | null; runtimeMinutes: number | null }): KinoMovieInput {
  return {
    ...movie,
    titleOriginal: movie.titleOriginal || facts.originalTitle || movie.titleOriginal,
    nationalities: movie.nationalities?.length ? movie.nationalities : facts.country ? [facts.country] : movie.nationalities,
    productionYear: kinoYear(movie) ? movie.productionYear : facts.year ? String(facts.year) : movie.productionYear,
    lengthInMinutes: movie.lengthInMinutes ? movie.lengthInMinutes : facts.runtimeMinutes ?? movie.lengthInMinutes,
  };
}

function isBetter(candidate: ImdbMatch, current: ImdbMatch | null): boolean {
  if (!current) return true;
  if (candidate.confidence === "high" && current.confidence !== "high") return true;
  if (candidate.confidence !== "high" && current.confidence === "high") return false;
  return candidate.score > current.score;
}

/**
 * Kino event/screening titles often wrap the real movie title in event or
 * translation framing -- "Filmklubben: FANTASIA" (film club prefix),
 * "Pitchblack Playback : Vangelis: Blade Runner" (event name + composer
 * prefix), "Asfaltjunglen - CIN" (trailing venue/version tag after a dash),
 * "CIN - Asfaltjunglen" (the same tag before it), "Soudain (All of a
 * Sudden)" (original/translated title in parens), "Den fabelagtige Amelie
 * fra Montmatre (re-release)" (trailing annotation instead). Every side of
 * every split is kept as its own candidate -- for the parenthetical case
 * that means both the outer title and the inner text, since which one is
 * the searchable title (an alternate title) vs. noise (an annotation like
 * "re-release") isn't decidable from the string alone; a pure-noise variant
 * just never scores well enough to win.
 */
// Known non-title venue/version tags that Kino (and paradisbio.dk's own
// pages, see paradisbio.ts) append or prepend around a dash -- "CIN" alone
// is short and generic enough to coincidentally text-match unrelated real
// titles (e.g. "Dabbe: Cin Çarpmasi"), so a dash-split side matching one of
// these is dropped rather than kept as its own searchable candidate.
const VENUE_VERSION_TAG = /^(CIN\b.*|Cin\s+Præs.*|Dk\s+\w+.*|Eng\s+\w+.*|orgtale.*)$/i;

export function titleStrippingVariants(title: string): string[] {
  const variants = new Set<string>();

  const parenMatch = title.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  if (parenMatch) {
    const outer = parenMatch[1]!.trim();
    const inner = parenMatch[2]!.trim();
    if (outer) variants.add(outer);
    if (inner) variants.add(inner);
  }

  if (title.includes(" - ")) {
    const beforeLastDash = title.slice(0, title.lastIndexOf(" - ")).trim();
    const afterFirstDash = title.slice(title.indexOf(" - ") + 3).trim();
    if (beforeLastDash && !VENUE_VERSION_TAG.test(beforeLastDash)) variants.add(beforeLastDash);
    if (afterFirstDash && !VENUE_VERSION_TAG.test(afterFirstDash)) variants.add(afterFirstDash);
  }

  if (title.includes(":")) {
    const parts = title
      .split(":")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length > 1) {
      variants.add(parts[parts.length - 1]!);
      variants.add(parts[0]!);
    }
  }

  variants.delete(title);
  return [...variants];
}

/**
 * Every candidate title worth trying for a single Kino listing: the title
 * itself (its trailing "(YYYY)" annotation dropped first, see
 * splitTrailingYear, so those digits don't pollute similarity scoring) plus
 * every variant titleStrippingVariants finds, expanded to a fixed point so
 * combinations compose -- e.g. a dash-suffixed listing with a parenthetical
 * original title inside it yields both the dash-stripped and paren-stripped
 * forms, not just one pass of each.
 */
export function extractCandidateTitles(rawTitle: string): string[] {
  const seed = splitTrailingYear(rawTitle).stripped;
  const candidates = new Set<string>([seed]);

  let frontier = [seed];
  for (let pass = 0; pass < 3 && frontier.length > 0; pass++) {
    const next: string[] = [];
    for (const title of frontier) {
      for (const variant of titleStrippingVariants(title)) {
        if (!candidates.has(variant)) {
          candidates.add(variant);
          next.push(variant);
        }
      }
    }
    frontier = next;
  }

  return [...candidates];
}

/**
 * Fully-automatic resolution: run the cheap 3-source search first. It
 * already tries every exact-match tier (title + release date, then title
 * alone, then Danish AKA title, see classifyExactMatchTier) before falling
 * back to fuzzy scoring, so most event framing, re-releases with a stale
 * premiere date, and bilingual titles resolve right here. If that isn't
 * already high confidence, scrape the movie's cinema venue page (currently
 * just Øst for Paradis / paradisbio.dk) for its original title / country /
 * year / runtime, and retry the same search with that filled in, keeping
 * whichever result scores best overall.
 */
export async function resolveImdbId(movie: KinoMovieInput, tmdbToken: string): Promise<ImdbMatch | null> {
  let best = await findImdbId(movie, tmdbToken);
  if (best && best.confidence === "high") return best;

  const facts = await fetchParadisbioFacts(movie.title).catch(() => null);
  if (facts && (facts.originalTitle || facts.country || facts.year || facts.runtimeMinutes)) {
    const enriched = mergeWithParadisbio(movie, facts);
    const retried = await findImdbId(enriched, tmdbToken).catch(() => null);
    if (retried && isBetter(retried, best)) best = { ...retried, enrichedFrom: "paradisbio" };
  }

  return best;
}
