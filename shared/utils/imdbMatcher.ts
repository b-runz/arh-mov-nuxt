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

interface Candidate {
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
}

type SourceName = "tmdb" | "imdb" | "suggest";

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

function scoreCandidate(movie: KinoMovieInput, candidate: Candidate): number {
  let score = 0;

  const rawKinoTitles = [movie.title, movie.titleOriginal].filter((t): t is string => !!t);
  const titleAnnotations = rawKinoTitles.map(splitTrailingYear);
  // Score against the raw title (with its "(YYYY)" annotation, if any) and
  // every event/version-framing and parenthetical-original-title variant
  // extracted from it (see extractCandidateTitles), and let the best-scoring
  // one win -- e.g. "Soudain (All of a Sudden)" needs to be scored against
  // "All of a Sudden" on its own to land a clean similarity match, not just
  // against the combined string; keeping the raw string too means stripping
  // it unconditionally is never required for a title that already matches
  // as-is.
  const kinoTitles = [...new Set([...rawKinoTitles, ...rawKinoTitles.flatMap(extractCandidateTitles)])];
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
  const yearCandidates = [...new Set([kinoYear(movie), ...titleAnnotations.map((t) => t.year)].filter((y): y is number => y !== null))];
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
  const res = await fetch(`${TMDB_BASE}/search/movie?${params}`, { headers: tmdbHeaders(token) });
  if (!res.ok) throw new Error(`TMDB search failed: ${res.status}`);
  return (await res.json()).results as TmdbSearchResult[];
}

async function tmdbDetails(token: string, id: number): Promise<TmdbMovieDetails> {
  // alternative_titles is appended alongside external_ids on the same
  // request (no extra round-trip) so the Danish AKA title is available for
  // scoring wherever a candidate's title is compared against Kino's.
  const res = await fetch(`${TMDB_BASE}/movie/${id}?append_to_response=external_ids,alternative_titles&language=en-US`, {
    headers: tmdbHeaders(token),
  });
  if (!res.ok) throw new Error(`TMDB details failed: ${res.status}`);
  return res.json() as Promise<TmdbMovieDetails>;
}

async function tmdbCandidates(movie: KinoMovieInput, token: string): Promise<Candidate[]> {
  if (!token) return [];
  const year = kinoYear(movie);
  const queries = candidateSearchTitles(movie);

  const seen = new Map<number, TmdbSearchResult>();
  const collect = async (withYear: boolean) => {
    const batches = await Promise.all(
      queries.map((q) => tmdbSearch(token, q, withYear && year ? String(year) : undefined).catch(() => []))
    );
    for (const batch of batches) for (const r of batch) seen.set(r.id, r);
  };
  await collect(true);
  if (seen.size === 0 && year) await collect(false);

  const top = [...seen.values()].slice(0, 6);
  const details = await Promise.all(top.map((c) => tmdbDetails(token, c.id).catch(() => null)));

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
}

async function imdbGraphqlSearch(term: string): Promise<ImdbSearchEntity[]> {
  const res = await fetch(IMDB_GRAPHQL_ENDPOINT, {
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
  const res = await fetch(url);
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
  return candidates.filter((c) => c.imdbId).map((candidate) => ({ source, candidate, score: scoreCandidate(movie, candidate) }));
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

  const byId = new Map<string, { bestScore: number; bestCandidate: Candidate; sources: Set<SourceName> }>();
  for (const { source, candidate, score } of all) {
    const id = candidate.imdbId!;
    const entry = byId.get(id);
    if (!entry) {
      byId.set(id, { bestScore: score, bestCandidate: candidate, sources: new Set([source]) });
    } else {
      entry.sources.add(source);
      if (score > entry.bestScore) {
        entry.bestScore = score;
        entry.bestCandidate = candidate;
      }
    }
  }

  const entries = [...byId.entries()].map(([id, e]) => ({
    id,
    candidate: e.bestCandidate,
    rawScore: e.bestScore,
    sources: e.sources,
  }));

  // "High" confidence requires 2+ independently-queried sources to land on
  // the same tt id AND that id to already have a credible score on its own
  // merits -- otherwise two engines sharing the same blind spot (e.g. both
  // mangling a special character the same way) can "agree" on a wrong
  // answer. Corroboration only ever promotes to high; it never influences
  // the fallback ranking below, so it can't bury a stronger single-source
  // exact match under a weak coincidental agreement.
  const agreed = entries.filter((e) => e.sources.size >= 2 && e.rawScore >= 40).sort((a, b) => b.rawScore - a.rawScore);
  const byRaw = [...entries].sort((a, b) => b.rawScore - a.rawScore);

  let confidence: ImdbMatch["confidence"];
  let best: (typeof entries)[number];
  let second: (typeof entries)[number] | undefined;

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
 * The same listing with every year signal removed. Kino's premiere is the
 * *Danish* premiere, so for a re-release it's the re-release date, not the
 * film's year (e.g. "Avengers: Endgame" listed with a 2026 premiere). Also
 * drops showCount: the wide-release heuristic in scoreCandidate rewards
 * candidate recency as a stand-in for a stale year, which is exactly the
 * signal a year-less retry is trying to switch off.
 */
export function withoutYear(movie: KinoMovieInput): KinoMovieInput {
  return { ...movie, premiere: undefined, productionYear: undefined, showCount: undefined };
}

/**
 * True when the match's title is a 1:1 normalized match for the Kino title
 * (or either side's original title). Used to gate the year-less retry: with
 * no year to discriminate, a same-title remake (Moana 2016 vs 2026) is a
 * coin flip and must not be accepted, but a single exact-title candidate
 * winning over merely-similar franchise siblings is unambiguous.
 */
export function isExactTitleMatch(movie: Pick<KinoMovieInput, "title" | "titleOriginal">, match: Pick<ImdbMatch, "candidateTitle" | "candidateOriginalTitle">): boolean {
  const rawKinoTitles = [movie.title, movie.titleOriginal].filter((t): t is string => !!t);
  // Include extracted variants (e.g. the inner title of "Soudain (All of a
  // Sudden)") so a bilingual/event-framed listing can still register as an
  // exact match against the plain candidate title it actually refers to.
  const kinoTitles = [...new Set([...rawKinoTitles, ...rawKinoTitles.flatMap(extractCandidateTitles)])];
  const candidateTitles = [match.candidateTitle, match.candidateOriginalTitle].filter(Boolean);
  return kinoTitles.some((kt) => candidateTitles.some((ct) => titleSimilarity(kt, ct) === 1));
}

/**
 * Fully-automatic resolution: run the cheap 3-source search first. It
 * already searches and scores every event/annotation/original-title variant
 * of the listing's title (see extractCandidateTitles), so most event framing
 * and bilingual titles resolve right here. If that isn't already high
 * confidence, try two fallbacks in order, keeping whichever result scores
 * best overall:
 *   1. Scrape the movie's cinema venue page (currently just Øst for Paradis
 *      / paradisbio.dk) for its original title / country / year / runtime,
 *      and retry the search with that filled in.
 *   2. Retry with Kino's year removed (see withoutYear), accepted only for
 *      a high-confidence, exact-title winner -- catches re-releases whose
 *      Danish premiere is years after the film's own release, and listings
 *      with no plausible year at all (see kinoYear's 1920 floor).
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
  if (best && best.confidence === "high") return best;

  if (kinoYear(movie) !== null) {
    const yearless = await findImdbId(withoutYear(movie), tmdbToken).catch(() => null);
    // Without a year the search can't tell same-title remakes apart, so only
    // a corroborated 1:1 title match counts; anything looser stays with the
    // year-aware result.
    if (yearless && yearless.confidence === "high" && isExactTitleMatch(movie, yearless) && isBetter(yearless, best)) {
      return { ...yearless, enrichedFrom: "no-year" };
    }
  }

  return best;
}
