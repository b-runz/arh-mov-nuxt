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

function kinoYear(movie: KinoMovieInput): number | null {
  if (movie.productionYear && /^\d{4}$/.test(movie.productionYear)) {
    return parseInt(movie.productionYear, 10);
  }
  if (movie.premiere) {
    const year = new Date(movie.premiere).getFullYear();
    if (!Number.isNaN(year)) return year;
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

const NON_THEATRICAL_TYPES = new Set(["TV Episode", "TV Series", "Video", "Podcast Episode", "Podcast Series", "Video Game", "Music Video"]);

// Below this many scheduled showtimes, a listing could plausibly be a
// one-off cinematheque/classic rerun (verified: real reruns in this data
// source have exactly 1 showtime) where Kino's year field, however old, is
// legitimately correct. At or above it, a schedule this size is
// unambiguously a new wide release.
const WIDE_RELEASE_SHOW_THRESHOLD = 20;

function scoreCandidate(movie: KinoMovieInput, candidate: Candidate): number {
  let score = 0;

  const kinoTitles = [movie.title, movie.titleOriginal].filter((t): t is string => !!t);
  const candidateTitles = [candidate.title, candidate.originalTitle].filter((t): t is string => !!t);
  const titleScores = kinoTitles.flatMap((kt) => candidateTitles.map((ct) => titleSimilarity(kt, ct)));
  let titleComponent = Math.max(0, ...titleScores) * 40;
  if (candidate.titleAlreadyRelevant) titleComponent = Math.max(titleComponent, 22);
  score += titleComponent;

  const kYear = kinoYear(movie);
  const isWideRelease = (movie.showCount ?? 0) >= WIDE_RELEASE_SHOW_THRESHOLD;
  const isCurrentRelease = candidate.year !== null && Math.abs(candidate.year - new Date().getFullYear()) <= 1;

  if (isWideRelease && isCurrentRelease) {
    // Kino's own premiere/year field is stale for this title (reused from
    // an earlier release under the same name) -- trust the candidate's own
    // recency over it, same weight as a genuine exact year match.
    score += 30;
  } else if (kYear !== null && candidate.year !== null) {
    const diff = Math.abs(kYear - candidate.year);
    if (diff === 0) score += 30;
    else if (diff === 1) score += 18;
    else score -= 20;
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
  else if (candidate.typeText && NON_THEATRICAL_TYPES.has(candidate.typeText)) score -= 25;

  score += popularityBonus(candidate.popularityRank);

  return score;
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
  const res = await fetch(`${TMDB_BASE}/movie/${id}?append_to_response=external_ids&language=en-US`, {
    headers: tmdbHeaders(token),
  });
  if (!res.ok) throw new Error(`TMDB details failed: ${res.status}`);
  return res.json() as Promise<TmdbMovieDetails>;
}

async function tmdbCandidates(movie: KinoMovieInput, token: string): Promise<Candidate[]> {
  if (!token) return [];
  const year = kinoYear(movie);
  const queries = [...new Set([movie.titleOriginal, movie.title].filter((t): t is string => !!t))];

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
    typeText: "Movie", // /search/movie only returns movies
    posterPath: d.poster_path,
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
    const sim = Math.max(titleSimilarity(target.title, c.title), titleSimilarity(target.title, c.originalTitle));
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operationName: "Search", query: IMDB_SEARCH_QUERY, variables: { term } }),
  });
  if (!res.ok) throw new Error(`IMDb search failed: ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`IMDb search error: ${json.errors[0]?.message}`);
  return (json.data?.mainSearch?.edges ?? []).map((e: { node: { entity: ImdbSearchEntity } }) => e.node.entity);
}

async function imdbGraphqlCandidates(movie: KinoMovieInput): Promise<Candidate[]> {
  const queries = [...new Set([movie.titleOriginal, movie.title].filter((t): t is string => !!t))];
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
  const queries = [...new Set([movie.titleOriginal, movie.title].filter((t): t is string => !!t))];
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
 * Kino event/screening titles often wrap the real movie title in event
 * framing -- "Filmklubben: FANTASIA" (film club prefix), "Pitchblack
 * Playback : Vangelis: Blade Runner" (event name + composer prefix),
 * "Den fabelagtige Amelie fra Montmatre (re-release)" (trailing annotation).
 * These variants are tried as a last resort and only kept if they score
 * better than what we already have, so a generic-word false positive (e.g.
 * an art installation whose subtitle happens to coincide with an unrelated
 * film) can only replace "no match" / a weak guess, never a good one.
 */
export function titleStrippingVariants(title: string): string[] {
  const variants = new Set<string>();

  const noParen = title.replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (noParen) variants.add(noParen);

  if (title.includes(" - ")) {
    const withoutLastDash = title.slice(0, title.lastIndexOf(" - ")).trim();
    if (withoutLastDash) variants.add(withoutLastDash);
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
 * Fully-automatic resolution: run the cheap 3-source search first. If that
 * isn't already high confidence, try two fallbacks in order, keeping
 * whichever result scores best overall:
 *   1. Scrape the movie's cinema venue page (currently just Øst for Paradis
 *      / paradisbio.dk) for its original title / country / year / runtime,
 *      and retry the search with that filled in.
 *   2. Strip event/annotation framing from the title (see
 *      titleStrippingVariants) and retry the search with each variant.
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

  for (const variant of titleStrippingVariants(movie.title)) {
    const stripped = await findImdbId({ ...movie, title: variant }, tmdbToken).catch(() => null);
    if (!stripped) continue;

    // Stripping is itself an unverified guess about what to throw away, so
    // demand a clearer margin than the base search needs before trusting a
    // "high" from it -- otherwise a generic word that happens to collide
    // with some real movie gets silently accepted.
    const candidate = stripped.confidence === "high" && stripped.margin < 5 ? { ...stripped, confidence: "low" as const } : stripped;
    if (isBetter(candidate, best)) best = { ...candidate, enrichedFrom: "title-strip" };
    if (best && best.confidence === "high") break;
  }

  return best;
}
