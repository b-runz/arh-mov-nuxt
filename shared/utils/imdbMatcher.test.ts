import { describe, test, expect } from "bun:test";
import { titleStrippingVariants, withoutYear, isExactTitleMatch } from "./imdbMatcher";

describe("titleStrippingVariants", () => {
  test("produces both colon parts", () => {
    expect(titleStrippingVariants("Avengers: Endgame")).toEqual(["Endgame", "Avengers"]);
  });
});

describe("withoutYear", () => {
  test("drops every year signal but keeps the rest of the listing", () => {
    expect(
      withoutYear({ title: "Avengers: Endgame", titleOriginal: "X", premiere: "2026-09-23", productionYear: "2026", nationalities: ["USA"], lengthInMinutes: 181, showCount: 40 })
    ).toEqual({ title: "Avengers: Endgame", titleOriginal: "X", premiere: undefined, productionYear: undefined, nationalities: ["USA"], lengthInMinutes: 181, showCount: undefined });
  });
});

describe("isExactTitleMatch", () => {
  const match = (candidateTitle: string, candidateOriginalTitle = candidateTitle) => ({ candidateTitle, candidateOriginalTitle });
  test("matches the Kino title exactly, ignoring case and punctuation", () => {
    expect(isExactTitleMatch({ title: "Avengers: Endgame" }, match("Avengers: Endgame"))).toBe(true);
    expect(isExactTitleMatch({ title: "AVENGERS ENDGAME" }, match("Avengers: Endgame"))).toBe(true);
  });
  test("accepts a match on the Kino original title or the candidate original title", () => {
    expect(isExactTitleMatch({ title: "Slutspil", titleOriginal: "Avengers: Endgame" }, match("Avengers: Endgame"))).toBe(true);
    expect(isExactTitleMatch({ title: "Amélie" }, match("Amelie", "Le Fabuleux Destin d'Amélie Poulain"))).toBe(true);
  });
  test("rejects partial and containment matches", () => {
    expect(isExactTitleMatch({ title: "Avengers: Endgame" }, match("Avengers: Doomsday"))).toBe(false);
    expect(isExactTitleMatch({ title: "Avengers" }, match("Avengers: Doomsday"))).toBe(false);
    expect(isExactTitleMatch({ title: "Avengers: Endgame" }, match("", ""))).toBe(false);
  });
});
