import { describe, test, expect } from "bun:test";
import { titleStrippingVariants, classifyExactMatchTier, isCorroborated } from "./imdbMatcher";
import type { Candidate, SourceName } from "./imdbMatcher";

describe("titleStrippingVariants", () => {
  test("produces both colon parts", () => {
    expect(titleStrippingVariants("Avengers: Endgame")).toEqual(["Endgame", "Avengers"]);
  });
});

describe("classifyExactMatchTier", () => {
  const candidate = (overrides: Partial<Candidate>): Candidate => ({
    imdbId: "tt0000000",
    title: "",
    originalTitle: "",
    year: null,
    countries: [],
    runtimeMinutes: null,
    typeText: null,
    ...overrides,
  });

  test("exact title and matching year is tier 1", () => {
    const movie = { title: "Avengers: Endgame", productionYear: "2019" };
    const c = candidate({ title: "Avengers: Endgame", originalTitle: "Avengers: Endgame", year: 2019 });
    expect(classifyExactMatchTier(movie, c)).toBe(1);
  });

  test("exact title with a mismatched year is tier 2, not tier 1", () => {
    const movie = { title: "Avengers: Endgame", premiere: "2026-09-23" };
    const c = candidate({ title: "Avengers: Endgame", originalTitle: "Avengers: Endgame", year: 2019 });
    expect(classifyExactMatchTier(movie, c)).toBe(2);
  });

  test("matches on the candidate's original title too", () => {
    const movie = { title: "Amelie" };
    const c = candidate({ title: "Amelie", originalTitle: "Le Fabuleux Destin d'Amélie Poulain", year: 2001 });
    expect(classifyExactMatchTier(movie, c)).toBe(2);
  });

  test("exact Danish AKA title with no primary title match is tier 3", () => {
    const movie = { title: "F for Får" };
    const c = candidate({ title: "Shaun the Sheep Movie", originalTitle: "Shaun the Sheep Movie", akaTitles: ["F for Får"] });
    expect(classifyExactMatchTier(movie, c)).toBe(3);
  });

  test("a shared franchise word alone does not count as an exact title match", () => {
    // Regression: Kino's re-release premiere for "Avengers: Endgame" reads as
    // 2026, coincidentally matching "Avengers: Doomsday"'s real year -- the
    // containment-based partial similarity for the extracted "Avengers"
    // fragment must not be promoted to an exact tier just because the two
    // titles share that word.
    const movie = { title: "Avengers: Endgame", premiere: "2026-09-23" };
    const c = candidate({ title: "Avengers: Doomsday", originalTitle: "Avengers: Doomsday", year: 2026 });
    expect(classifyExactMatchTier(movie, c)).toBeNull();
  });

  test("no title or aka match at all is null", () => {
    const movie = { title: "Garance" };
    const c = candidate({ title: "Another Day", originalTitle: "Some Other Title" });
    expect(classifyExactMatchTier(movie, c)).toBeNull();
  });

  test("an exact match on Kino's raw title is trusted even with a huge year gap", () => {
    // A genuine re-release can be any age -- 7 years or 50 -- so there's no
    // sound cutoff for how large a gap to tolerate. What actually makes this
    // trustworthy is that it's Kino's own raw, unmodified title matching
    // exactly, not something we derived ourselves by splitting it.
    const movie = { title: "Jaws", premiere: "2026-06-01" };
    const c = candidate({ title: "Jaws", originalTitle: "Jaws", year: 1975 });
    expect(classifyExactMatchTier(movie, c)).toBe(2);
  });

  test("an exact match only via a colon-extracted fragment defers instead of overriding the year", () => {
    // Regression: "Dune: Del 3"'s extracted "Dune" fragment exact-matches the
    // unrelated 1984 "Dune" -- Kino's raw title never matches it (only the
    // fragment does), so unlike a real re-release this isn't backed by an
    // authoritative exact match, and shouldn't override a wildly different
    // year. The real "Dune: Part Three" only has partial similarity here and
    // must be left to the year-aware fuzzy fallback to find instead.
    const movie = { title: "Dune: Del 3", premiere: "2026-12-16" };
    const c = candidate({ title: "Dune", originalTitle: "Dune", year: 1984 });
    expect(classifyExactMatchTier(movie, c)).toBeNull();
  });

  test("a colon-extracted fragment match defers even with no year data at all", () => {
    // A fragment match isn't authoritative just because there's no year to
    // contradict it either -- it still needs corroboration to count.
    const movie = { title: "Practical Magic: Magi i familien" };
    const c = candidate({ title: "Practical Magic", originalTitle: "Practical Magic", year: 1998 });
    expect(classifyExactMatchTier(movie, c)).toBeNull();
  });

  test("an exact AKA match is trusted even with a huge year gap", () => {
    // The candidate's AKA is TMDB's own official alternate title, not
    // something we guessed by splitting Kino's string, so it gets the same
    // trust as a raw title match.
    const movie = { title: "F for Får" };
    const c = candidate({ title: "Something Else", originalTitle: "Something Else Original", year: 1990, akaTitles: ["F for Får"] });
    expect(classifyExactMatchTier(movie, c)).toBe(3);
  });
});

describe("isCorroborated", () => {
  const sources = (...names: SourceName[]) => new Set(names);

  test("tier 1 accepts any 2 sources regardless of votes", () => {
    // Tier 1 already has a matching year from Kino's own, separate data
    // backing it up, so any 2-of-3 source agreement is real corroboration.
    expect(isCorroborated(1, sources("imdb", "suggest"), 0)).toBe(true);
  });

  test("tier 2/3 accept 2 sources when tmdb is one of them, regardless of votes", () => {
    expect(isCorroborated(2, sources("tmdb", "imdb"), 0)).toBe(true);
    expect(isCorroborated(3, sources("tmdb", "suggest"), 0)).toBe(true);
  });

  test("tier 2/3 accept 2 sources without tmdb when the candidate has real votes", () => {
    expect(isCorroborated(2, sources("imdb", "suggest"), 68)).toBe(true);
  });

  test("tier 2/3 reject 2 sources without tmdb and with zero votes", () => {
    // Regression: Kino's "Filmquiz" (a pub-quiz night, not a real film)
    // coincidentally shares its name with an obscure 1991 film that only
    // IMDb's own search and autocomplete "agreed" on (0 votes, no TMDB
    // entry cross-linked) -- and the exact same fingerprint (0 votes,
    // imdb+suggest only) turns up for at least one genuinely correct match
    // too (a brand-new, not-yet-rated release), so this can't be told apart
    // from a real film by evidence alone. Reported as low confidence rather
    // than trusted, so the caller leaves it unresolved.
    expect(isCorroborated(2, sources("imdb", "suggest"), 0)).toBe(false);
    expect(isCorroborated(3, sources("imdb", "suggest"), null)).toBe(false);
  });

  test("a single source never corroborates, at any tier", () => {
    expect(isCorroborated(1, sources("tmdb"), 100)).toBe(false);
    expect(isCorroborated(2, sources("tmdb"), 100)).toBe(false);
  });
});
