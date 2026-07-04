// Scrapes Øst for Paradis's own site (paradisbio.dk) for movie facts (original
// title, country, year, runtime, director) that the Kino GraphQL API doesn't
// expose. Many of Kino's hardest-to-match titles -- arthouse classics,
// "- CIN" cinematheque screenings, foreign films under a Danish title --
// play exclusively at this venue, and its own movie_details pages carry
// exactly the disambiguating facts the IMDb/TMDB search fails to recover
// from the bare title (see e.g. "At Leve" -> original title "Huo zhe",
// China, 1994, dir. Zhang Yimou).
//
// The site has no API; this scrapes plain HTML. It's used strictly as a
// fallback enrichment step (only when the title-only search comes back low
// confidence), so occasional scrape failures just mean no enrichment, not a
// broken pipeline.

export interface ParadisbioFacts {
  originalTitle: string | null;
  country: string | null;
  year: number | null;
  runtimeMinutes: number | null;
  director: string | null;
}

const BASE = "https://www.paradisbio.dk";
const HEADERS = { "User-Agent": "Mozilla/5.0" };

let indexPromise: Promise<Map<string, string>> | null = null;

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&aelig;/gi, "æ")
    .replace(/&Aelig;/g, "Æ")
    .replace(/&oslash;/gi, "ø")
    .replace(/&Oslash;/g, "Ø")
    .replace(/&aring;/gi, "å")
    .replace(/&Aring;/g, "Å")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

async function fetchIndex(): Promise<Map<string, string>> {
  const res = await fetch(`${BASE}/upcomming_movies/`, { headers: HEADERS });
  if (!res.ok) throw new Error(`paradisbio upcoming list failed: ${res.status}`);
  const html = await res.text();
  const map = new Map<string, string>();
  const re = /<a href="(\/movie_details\/\d+)[^"]*"[^>]*>[\s\S]*?<span>([^<]+)<\/span>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    map.set(decodeHtmlEntities(m[2]!).trim(), m[1]!);
  }
  return map;
}

function getIndex(): Promise<Map<string, string>> {
  if (!indexPromise) indexPromise = fetchIndex();
  return indexPromise;
}

function parseFacts(rawHtml: string): ParadisbioFacts {
  const html = decodeHtmlEntities(rawHtml);
  const block = html.match(/<div class="container-fluid filmfacts">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/);
  const source = block ? block[0] : html;

  const facts: Record<string, string> = {};
  const re = /([A-Za-zÆØÅæøå/ ]{2,30}?)\s*<h5>\s*([^<]*?)\s*<\/h5>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    facts[m[1]!.trim().toLowerCase()] = m[2]!.trim();
  }

  let country: string | null = null;
  let year: number | null = null;
  const landAar = facts["land/år"];
  if (landAar) {
    const [countryPart] = landAar.split("/").map((p) => p.trim());
    if (countryPart && !/^\d{4}$/.test(countryPart)) country = countryPart;
    const yearMatch = landAar.match(/(\d{4})/);
    if (yearMatch) year = parseInt(yearMatch[1]!, 10);
  }

  let runtimeMinutes: number | null = null;
  const spilletid = facts["spilletid"];
  if (spilletid) {
    const hm = spilletid.match(/(\d+):(\d+)/);
    if (hm) runtimeMinutes = parseInt(hm[1]!, 10) * 60 + parseInt(hm[2]!, 10);
  }

  // Strip Kino/venue version tags that sometimes leak into the "original
  // title" field (e.g. "Vores Løfte - Dk undertekster", "... - CIN").
  const originalTitle = facts["originaltitel"]
    ? facts["originaltitel"].replace(/\s*-\s*(CIN\b.*|Cin\s+Præs.*|Dk\s+\w+.*|Eng\s+\w+.*|orgtale.*)$/i, "").trim()
    : null;

  return {
    originalTitle: originalTitle || null,
    country,
    year,
    runtimeMinutes,
    director: facts["instruktion"] || null,
  };
}

export async function fetchParadisbioFacts(kinoTitle: string): Promise<ParadisbioFacts | null> {
  const index = await getIndex();
  const trimmed = kinoTitle.trim();
  let url = index.get(trimmed);

  // Kino's own `title` field often omits the venue's version-tag suffix
  // (paradisbio lists "Asfaltjunglen - CIN" while Kino just says
  // "Asfaltjunglen") -- fall back to a "<title> -..." prefix match.
  if (!url) {
    for (const [key, value] of index) {
      if (key.startsWith(`${trimmed} -`)) {
        url = value;
        break;
      }
    }
  }

  if (!url) return null;
  const res = await fetch(`${BASE}${url}`, { headers: HEADERS });
  if (!res.ok) return null;
  return parseFacts(await res.text());
}
