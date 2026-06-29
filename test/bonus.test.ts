import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveKnockoutActual,
  computeActualGroupTables,
  computeExtraPoints,
  toKnockoutActual,
} from "../src/bonus.ts";
import { scoreKnockout, type KnockoutPrediction } from "../src/scoring.ts";
import type { FixtureInfo } from "../src/predictions.ts";
import type { LiveMatch, Score } from "../src/types.ts";

// ── Hjälpare ──────────────────────────────────────────────────────────────────
function ko(round: string, home: string, away: string, status = "NS", winner: string | null = null): LiveMatch {
  return {
    fixtureId: 0,
    leagueId: 1,
    round,
    date: "",
    home: { id: 0, name: home },
    away: { id: 0, name: away },
    score: { home: 0, away: 0 },
    status,
    elapsed: null,
    winner,
  };
}

function fi(home: string, away: string, group: string): FixtureInfo {
  return { home, away, homeSv: home, awaySv: away, group, excelDate: "", kickoff: null, fixtureId: null };
}

const emptyKo = (): KnockoutPrediction["teamsByRound"] => ({ R32: [], R16: [], QF: [], SF: [], FINAL: [], CHAMPION: [] });

// ── deriveKnockoutActual ──────────────────────────────────────────────────────
test("deriveKnockoutActual: rätt rond-mappning + namnkanonisering", () => {
  const a = deriveKnockoutActual([
    ko("Round of 16", "Spain", "Croatia"),
    ko("Round of 16", "Germany", "Czechia"), // alias → Czech Republic
    ko("Quarter-finals", "Spain", "Germany"),
    ko("Semi-finals", "Spain", "France"),
  ]);
  assert.deepEqual(new Set(a.teamsByRound.R16), new Set(["Spain", "Croatia", "Germany", "Czech Republic"]));
  assert.deepEqual(new Set(a.teamsByRound.QF), new Set(["Spain", "Germany"]));
  assert.deepEqual(new Set(a.teamsByRound.SF), new Set(["Spain", "France"]));
});

test("deriveKnockoutActual: bronsmatchen exkluderas, mästare = finalvinnaren", () => {
  const a = deriveKnockoutActual([
    ko("3rd Place Final", "Germany", "France", "FT", "Germany"),
    ko("Final", "Spain", "Brazil", "FT", "Spain"),
  ]);
  assert.deepEqual(new Set(a.teamsByRound.FINAL), new Set(["Spain", "Brazil"]));
  assert.equal(a.champion, "Spain");
  // Germany/France (bronsmatch) ska INTE räknas som finalister.
  assert.ok(!a.teamsByRound.FINAL!.includes("Germany"));
});

test("deriveKnockoutActual: champion sätts inte förrän finalen är slutspelad", () => {
  const a = deriveKnockoutActual([ko("Final", "Spain", "Brazil", "NS", null)]);
  assert.equal(a.champion, undefined);
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

  const actual = toKnockoutActual(deriveKnockoutActual([ko("Round of 16", "Spain", "Croatia")]));

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
