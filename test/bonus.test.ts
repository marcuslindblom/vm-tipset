import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveKnockoutActual,
  computeActualGroupTables,
  computeExtraPoints,
  toKnockoutActual,
  knockoutCardText,
  knockoutScheduleText,
  roundNameSv,
  bracketFromResults,
  type KoFixture,
} from "../src/bonus.ts";
import { scoreKnockout, computeStandings, type KnockoutPrediction, type Prediction } from "../src/scoring.ts";
import type { FixtureInfo } from "../src/predictions.ts";
import type { LiveMatch, MatchResult, Score } from "../src/types.ts";

// ── Hjälpare ──────────────────────────────────────────────────────────────────
function ko(
  round: string,
  home: string,
  away: string,
  status = "NS",
  winner: string | null = null,
  score: Score = { home: 0, away: 0 },
): LiveMatch {
  return {
    fixtureId: 0,
    leagueId: 1,
    round,
    date: "",
    home: { id: 0, name: home },
    away: { id: 0, name: away },
    score,
    status,
    elapsed: null,
    winner,
  };
}

function koPred(over: Partial<KnockoutPrediction["teamsByRound"]>, champion = ""): KnockoutPrediction {
  return { teamsByRound: { ...emptyKo(), ...over }, champion, topScorer: "", topScorerGoals: 0, totalGoals: 0 };
}

function fi(home: string, away: string, group: string): FixtureInfo {
  return { home, away, homeSv: home, awaySv: away, group, excelDate: "", kickoff: null, fixtureId: null };
}

const emptyKo = (): KnockoutPrediction["teamsByRound"] => ({ R32: [], R16: [], QF: [], SF: [], FINAL: [], CHAMPION: [] });

// ── deriveKnockoutActual (vinnarbaserad: nå nästa rond = vinna sin match) ──────
test("deriveKnockoutActual: R32 = deltagare, R16 = R32-vinnare (+ namnkanonisering)", () => {
  const a = deriveKnockoutActual([
    ko("Round of 32", "Spain", "Croatia", "FT", "Spain"),
    ko("Round of 32", "Germany", "Czechia", "PEN", "Czechia"), // alias → Czech Republic
    ko("Round of 32", "Brazil", "Japan", "NS", null), // ej spelad än
  ]);
  // Alla som SPELAR R32 har nått R32.
  assert.deepEqual(
    new Set(a.teamsByRound.R32),
    new Set(["Spain", "Croatia", "Germany", "Czech Republic", "Brazil", "Japan"]),
  );
  // R16 = vinnarna (även en vunnen-men-ej-lottad nästa match räknas direkt).
  assert.deepEqual(new Set(a.teamsByRound.R16), new Set(["Spain", "Czech Republic"]));
});

test("deriveKnockoutActual: SF-vinnare → final, finalvinnare → mästare, brons exkluderas", () => {
  const a = deriveKnockoutActual([
    ko("Semi-finals", "Spain", "France", "FT", "Spain"),
    ko("Semi-finals", "Brazil", "Argentina", "FT", "Brazil"),
    ko("3rd Place Final", "France", "Argentina", "FT", "France"), // brons – ingen rond
    ko("Final", "Spain", "Brazil", "FT", "Spain"),
  ]);
  assert.deepEqual(new Set(a.teamsByRound.FINAL), new Set(["Spain", "Brazil"])); // SF-vinnarna
  assert.equal(a.champion, "Spain");
  assert.ok(!(a.teamsByRound.FINAL ?? []).includes("France")); // bronslag ej finalist
});

test("deriveKnockoutActual: champion sätts inte förrän finalen är avgjord", () => {
  const a = deriveKnockoutActual([ko("Final", "Spain", "Brazil", "NS", null)]);
  assert.equal(a.champion, undefined);
});

test("bracketFromResults: härleder trädet ur lagrade resultat, skippar gruppmatcher (ingen rond)", () => {
  const mr = (o: Partial<MatchResult> & Pick<MatchResult, "home" | "away">): MatchResult => ({
    fixtureId: 0, score: { home: 0, away: 0 }, status: "FT", final: true, ...o,
  });
  const results: Record<string, MatchResult> = {
    g1: mr({ home: "Brazil", away: "Sweden" }), // gruppmatch – ingen rond
    k1: mr({ home: "Spain", away: "Croatia", round: "Round of 32", winner: "Spain" }),
    k2: mr({ home: "Spain", away: "Germany", round: "Round of 16", winner: "Spain" }),
  };
  const a = bracketFromResults(results);
  assert.deepEqual(new Set(a.teamsByRound.R32), new Set(["Spain", "Croatia"])); // R32-deltagare, gruppmatch ej med
  assert.deepEqual(new Set(a.teamsByRound.R16), new Set(["Spain"])); // R32-vinnare
  assert.deepEqual(new Set(a.teamsByRound.QF), new Set(["Spain"])); // R16-vinnare
});

// ── computeActualGroupTables ──────────────────────────────────────────────────
const GROUP_A_FIX: Record<string, FixtureInfo> = {
  a1: fi("Brazil", "Sweden", "A"),
  a2: fi("Brazil", "Serbia", "A"),
  a3: fi("Brazil", "Switzerland", "A"),
  a4: fi("Sweden", "Serbia", "A"),
  a5: fi("Sweden", "Switzerland", "A"),
  a6: fi("Serbia", "Switzerland", "A"),
};
const GROUP_A_RES: [string, Score][] = [
  ["a1", { home: 1, away: 0 }],
  ["a2", { home: 2, away: 0 }],
  ["a3", { home: 3, away: 0 }],
  ["a4", { home: 2, away: 1 }],
  ["a5", { home: 1, away: 0 }],
  ["a6", { home: 1, away: 1 }],
];

test("computeActualGroupTables: etta/tvåa ur färdigspelad grupp", () => {
  const tbl = computeActualGroupTables(new Map(GROUP_A_RES), GROUP_A_FIX);
  assert.deepEqual(tbl.get("A"), { first: "Brazil", second: "Sweden" });
});

test("computeActualGroupTables: ofullständig grupp ger ingen placering", () => {
  const fixtures = { ...GROUP_A_FIX, b1: fi("Spain", "Italy", "B") }; // b1 saknar resultat
  const tbl = computeActualGroupTables(new Map(GROUP_A_RES), fixtures);
  assert.ok(tbl.has("A"));
  assert.ok(!tbl.has("B"));
});

// ── computeExtraPoints (grupp-placering + slutspel) ────────────────────────────
test("computeExtraPoints: summerar grupp-placering + slutspel per spelare", () => {
  const groupPreds = new Map<string, Map<string, { home: number; away: number }>>();
  for (const [key, score] of GROUP_A_RES) {
    // Anna tippar exakt som utfallet (→ rätt etta+tvåa = 2+1). Bo tippar omvänt.
    groupPreds.set(
      key,
      new Map([
        ["Anna", { home: score.home, away: score.away }],
        ["Bo", { home: score.away, away: score.home }],
      ]),
    );
  }

  const knockoutPreds = new Map<string, KnockoutPrediction>([
    ["Anna", { teamsByRound: { ...emptyKo(), R16: ["Spain"] }, champion: "", topScorer: "", topScorerGoals: 0, totalGoals: 0 }],
    ["Bo", { teamsByRound: emptyKo(), champion: "", topScorer: "", topScorerGoals: 0, totalGoals: 0 }],
  ]);

  // Spain vinner sin R32-match → har nått R16.
  const actual = toKnockoutActual(deriveKnockoutActual([ko("Round of 32", "Spain", "Italy", "FT", "Spain")]));

  const extra = computeExtraPoints({
    players: ["Anna", "Bo"],
    groupPreds,
    fixtures: GROUP_A_FIX,
    results: new Map(GROUP_A_RES),
    knockoutPreds,
    knockoutActual: actual,
  });

  // Anna: grupp-placering 2+1 = 3, slutspel R16 (Spain) = 2 → 5.
  assert.equal(extra.get("Anna"), 5);
  // Bo: fel grupptabell (0) + inga slutspelstips (0) → utelämnas helt.
  assert.equal(extra.has("Bo"), false);
});

// ── Vinnare ur avgörande resultat om winner-fältet släpar i feeden ────────────
test("deriveKnockoutActual: härleder vinnare ur avgörande resultat om winner-fältet saknas", () => {
  const a = deriveKnockoutActual([ko("Round of 32", "Spain", "Italy", "FT", null, { home: 2, away: 1 })]);
  assert.deepEqual(new Set(a.teamsByRound.R16), new Set(["Spain"]));
});

test("deriveKnockoutActual: oavgjort utan winner-fält (väntar straffar) → ingen går vidare än", () => {
  const a = deriveKnockoutActual([ko("Round of 32", "Spain", "Italy", "PEN", null, { home: 1, away: 1 })]);
  assert.equal(a.teamsByRound.R16, undefined);
});

// ── Presentationskortet (knockoutCardText) ────────────────────────────────────
test("knockoutCardText: avspark listar vem som tippat lagen vidare + rätt rond/poäng", () => {
  const preds = new Map([
    ["Anna", koPred({ R16: ["Spain"] })],
    ["Bo", koPred({ R16: ["Italy"] })],
  ]);
  const card = knockoutCardText({
    kind: "kickoff", roundStr: "Round of 32", homeEn: "Spain", awayEn: "Italy",
    score: { home: 0, away: 0 }, winner: null, knockoutPreds: preds,
  });
  assert.match(card.koTips!, /Vidare till åttondelsfinalen \(2 p\)/);
  assert.match(card.koTips!, /→ Anna/); // Spain-raden
  assert.match(card.koTips!, /→ Bo/); // Italy-raden
  assert.equal(card.koResult, undefined);
});

test("knockoutCardText: full tid – vinnaren går vidare, rätt tippare får rundpoängen", () => {
  const preds = new Map([
    ["Anna", koPred({ R16: ["Spain"] })],
    ["Bo", koPred({ R16: ["Italy"] })],
  ]);
  const card = knockoutCardText({
    kind: "fulltime", roundStr: "Round of 32", homeEn: "Spain", awayEn: "Italy",
    score: { home: 2, away: 1 }, winner: "Spain", knockoutPreds: preds,
  });
  assert.match(card.koResult!, /vidare till åttondelsfinalen/);
  assert.match(card.koResult!, /\+2 p: Anna/);
  assert.ok(!card.koResult!.includes("Bo")); // Italy-tipparen får inget
  assert.equal(card.koTips, undefined);
});

test("knockoutCardText: finalvinnare blir världsmästare (+10)", () => {
  const preds = new Map([
    ["Anna", koPred({}, "Spain")],
    ["Bo", koPred({}, "Brazil")],
  ]);
  const card = knockoutCardText({
    kind: "fulltime", roundStr: "Final", homeEn: "Spain", awayEn: "Brazil",
    score: { home: 1, away: 0 }, winner: "Spain", knockoutPreds: preds,
  });
  assert.match(card.koResult!, /är världsmästare/);
  assert.match(card.koResult!, /\+10 p: Anna/);
});

test("knockoutCardText: skräll – ingen tippade vinnaren vidare", () => {
  const preds = new Map([["Anna", koPred({ R16: ["Spain"] })]]);
  const card = knockoutCardText({
    kind: "fulltime", roundStr: "Round of 32", homeEn: "Italy", awayEn: "Paraguay",
    score: { home: 1, away: 1 }, winner: "Paraguay", knockoutPreds: preds,
  });
  assert.match(card.koResult!, /Paraguay vidare.*ingen tippade det/);
});

test("knockoutCardText: bronsmatch ger inget kort", () => {
  const card = knockoutCardText({
    kind: "fulltime", roundStr: "3rd Place Final", homeEn: "France", awayEn: "Argentina",
    score: { home: 1, away: 0 }, winner: "France", knockoutPreds: new Map(),
  });
  assert.deepEqual(card, {});
});

// ── End-to-end: computeStandings = gruppmatchpoäng + extraPoints ───────────────
test("end-to-end: totalen = gruppmatchpoäng + grupp-placering + slutspel", () => {
  const groupPreds = new Map<string, Map<string, Prediction>>();
  for (const [key, s] of GROUP_A_RES) groupPreds.set(key, new Map([["Anna", { home: s.home, away: s.away }]])); // exakt

  const knockoutPreds = new Map([["Anna", koPred({ R16: ["Spain"] })]]);
  const actual = toKnockoutActual(deriveKnockoutActual([ko("Round of 32", "Spain", "Italy", "FT", "Spain")]));
  const extra = computeExtraPoints({
    players: ["Anna"], groupPreds, fixtures: GROUP_A_FIX, results: new Map(GROUP_A_RES), knockoutPreds, knockoutActual: actual,
  });

  const anna = computeStandings(["Anna"], groupPreds, new Map(GROUP_A_RES), extra)[0];
  assert.equal(anna.groupPoints, 24); // 6 exakta × 4
  assert.equal(anna.bonusPoints, 5); // grupp-placering (2+1) + R16 Spain (2)
  assert.equal(anna.points, 29);
});

// ── Slutspelsschema för @arne ("nästa match") ─────────────────────────────────
test("roundNameSv: matchens egen rond i obestämd form", () => {
  assert.equal(roundNameSv("Round of 32"), "sextondelsfinal");
  assert.equal(roundNameSv("Quarter-finals"), "kvartsfinal");
  assert.equal(roundNameSv("Final"), "final");
  assert.equal(roundNameSv("Group Stage - 1"), ""); // gruppspel → tomt
});

test("knockoutScheduleText: NÄSTA = närmaste kommande, PÅGÅR för live, filtrerar spelade/placeholder", () => {
  const now = Date.parse("2026-07-02T12:00:00Z");
  const fx: KoFixture[] = [
    { round: "Round of 32", home: "Brazil", away: "Japan", kickoff: "2026-07-01T20:00:00Z", status: "FT" }, // spelad
    { round: "Round of 16", home: "France", away: "Sweden", kickoff: "2026-07-02T20:00:00Z", status: "NS" }, // senare
    { round: "Round of 16", home: "Spain", away: "Italy", kickoff: "2026-07-02T18:00:00Z", status: "NS" }, // NÄSTA
    { round: "Round of 32", home: "Canada", away: "Morocco", kickoff: "2026-07-02T11:00:00Z", status: "2H" }, // live
    { round: "Round of 16", home: "", away: "", kickoff: "2026-07-02T14:00:00Z", status: "NS" }, // placeholder
  ];
  const text = knockoutScheduleText(fx, now)!;
  assert.match(text, /PÅGÅR: Kanada/); // live-match
  assert.match(text, /NÄSTA: Spanien/); // närmaste kommande (18:00), inte placeholder (14:00) eller France (20:00)
  assert.match(text, /åttondelsfinal, avspark 2026-07-02 18:00 UTC/);
  assert.ok(!/Frankrike|Sverige/.test(text)); // den senare R16-matchen ska inte vara NÄSTA
});

test("knockoutScheduleText: null när inget pågår eller väntar", () => {
  const now = Date.parse("2026-07-20T12:00:00Z");
  const fx: KoFixture[] = [{ round: "Final", home: "Spain", away: "Brazil", kickoff: "2026-07-19T20:00:00Z", status: "FT" }];
  assert.equal(knockoutScheduleText(fx, now), null);
});

// ── Skyttekung: tolerant namnmatchning (diakriter, skiftläge, förkortning) ─────
test("scoreKnockout: skyttekung matchas trots saknad accent", () => {
  const pred: KnockoutPrediction = {
    teamsByRound: emptyKo(),
    champion: "",
    topScorer: "Kylian Mbappé",
    topScorerGoals: 0,
    totalGoals: 0,
  };
  assert.equal(scoreKnockout(pred, { teamsByRound: {}, topScorer: "Kylian Mbappe" }), 8);
});

test("scoreKnockout: skyttekung matchas mot API:ts förkortade namn (L. Messi)", () => {
  const pred: KnockoutPrediction = {
    teamsByRound: emptyKo(),
    champion: "",
    topScorer: "Lionel Messi", // som i Excel
    topScorerGoals: 0,
    totalGoals: 0,
  };
  // API returnerar förkortat – ska ändå matcha (samma efternamn + förnamnsinitial).
  assert.equal(scoreKnockout(pred, { teamsByRound: {}, topScorer: "L. Messi" }), 8);
  // Annan spelare med samma efternamn men annan initial ska INTE matcha.
  assert.equal(scoreKnockout(pred, { teamsByRound: {}, topScorer: "A. Messi" }), 0);
});
