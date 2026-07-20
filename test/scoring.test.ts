import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gradeMatch,
  computeStandings,
  scoreKnockout,
  predictedGroupTable,
  scoreGroupPlacements,
  type Prediction,
  type KnockoutPrediction,
} from "../src/scoring.ts";

// ── Gruppmatch: 2 (tecken) + 2 (resultat) => exakt 4, inget för målskillnad ──
test("gradeMatch: exakt resultat = 4 (2 tecken + 2 resultat)", () => {
  assert.equal(gradeMatch({ home: 2, away: 1 }, { home: 2, away: 1 }), 4);
  assert.equal(gradeMatch({ home: 0, away: 0 }, { home: 0, away: 0 }), 4);
});

test("gradeMatch: rätt tecken men fel resultat = 2 (ingen målskillnads-bonus)", () => {
  assert.equal(gradeMatch({ home: 2, away: 1 }, { home: 3, away: 2 }), 2); // samma målskillnad spelar ingen roll
  assert.equal(gradeMatch({ home: 2, away: 0 }, { home: 1, away: 0 }), 2); // hemmavinst
  assert.equal(gradeMatch({ home: 1, away: 1 }, { home: 2, away: 2 }), 2); // oavgjort, fel siffror = rätt tecken
});

test("gradeMatch: fel tecken = 0", () => {
  assert.equal(gradeMatch({ home: 2, away: 0 }, { home: 0, away: 1 }), 0);
  assert.equal(gradeMatch({ home: 1, away: 1 }, { home: 2, away: 0 }), 0);
});

test("computeStandings: summerar (4/2/0), sorterar och rankar", () => {
  const preds = new Map<string, Map<string, Prediction>>([
    ["m1", new Map([["Anna", { home: 2, away: 1 }], ["Erik", { home: 1, away: 0 }], ["Johan", { home: 0, away: 0 }]])],
    ["m2", new Map([["Anna", { home: 1, away: 1 }], ["Erik", { home: 2, away: 2 }], ["Johan", { home: 3, away: 0 }]])],
  ]);
  const results = new Map([
    ["m1", { home: 2, away: 1 }],
    ["m2", { home: 1, away: 1 }],
  ]);
  // Anna: m1 exakt 4 + m2 exakt 4 = 8 (2 exakta)
  // Erik: m1 1-0 vs 2-1 rätt tecken 2 ; m2 2-2 vs 1-1 rätt tecken 2 = 4
  // Johan: 0 + 0 = 0
  const rows = computeStandings(["Anna", "Erik", "Johan"], preds, results);
  assert.deepEqual(
    rows.map((r) => [r.player, r.points, r.exact, r.rank]),
    [
      ["Anna", 8, 2, 1],
      ["Erik", 4, 0, 2],
      ["Johan", 0, 0, 3],
    ],
  );
});

test("computeStandings: lika poäng delar placering, pilar mot förra rankingen", () => {
  const preds = new Map<string, Map<string, Prediction>>([
    ["m1", new Map([["A", { home: 1, away: 0 }], ["B", { home: 1, away: 0 }], ["C", { home: 0, away: 0 }]])],
  ]);
  const results = new Map([["m1", { home: 1, away: 0 }]]);
  const prev = new Map([["A", 3], ["B", 1], ["C", 2]]);
  const rows = computeStandings(["A", "B", "C"], preds, results, new Map(), prev);
  const byPlayer = new Map(rows.map((r) => [r.player, r]));
  assert.equal(byPlayer.get("A")!.rank, 1);
  assert.equal(byPlayer.get("B")!.rank, 1); // delad 1:a (båda exakt = 4)
  assert.equal(byPlayer.get("C")!.rank, 3);
  assert.equal(byPlayer.get("A")!.delta, 2); // 3 -> 1
});

test("computeStandings: extraPoints (placering/slutspel/bonus) adderas", () => {
  const rows = computeStandings(["A", "B"], new Map(), new Map(), new Map([["B", 10]]));
  const byPlayer = new Map(rows.map((r) => [r.player, r]));
  assert.equal(byPlayer.get("B")!.points, 10);
  assert.equal(byPlayer.get("B")!.rank, 1);
});

test("computeStandings: utslagsfrågan bryter lika poäng (närmast verkligt målantal)", () => {
  const preds = new Map<string, Map<string, Prediction>>([
    ["m1", new Map([["A", { home: 1, away: 0 }], ["B", { home: 1, away: 0 }]])],
  ]);
  const results = new Map([["m1", { home: 1, away: 0 }]]); // båda exakt = 4 p ⇒ lika
  const tie = { actualTotalGoals: 200, predictedTotals: new Map([["A", 205], ["B", 198]]) };
  // B (avstånd 2) närmare än A (avstånd 5) ⇒ B före A, distinkta placeringar
  const rows = computeStandings(["A", "B"], preds, results, new Map(), null, tie);
  assert.deepEqual(rows.map((r) => [r.player, r.rank]), [["B", 1], ["A", 2]]);
});

test("computeStandings: utan utslagsfråga delas placering fortfarande (oförändrat)", () => {
  const preds = new Map<string, Map<string, Prediction>>([
    ["m1", new Map([["A", { home: 1, away: 0 }], ["B", { home: 1, away: 0 }]])],
  ]);
  const results = new Map([["m1", { home: 1, away: 0 }]]);
  const rows = computeStandings(["A", "B"], preds, results);
  assert.deepEqual(rows.map((r) => r.rank), [1, 1]); // delad 1:a
});

// ── Grupp-placering: 2 p rätt etta, 1 p rätt tvåa ─────────────────────────────
test("predictedGroupTable: härleder tabell ur tippade resultat", () => {
  const teams = ["Sverige", "Brasilien", "Serbien", "Schweiz"];
  // Brasilien vinner allt, Sverige tvåa.
  const table = predictedGroupTable(teams, [
    { home: "Brasilien", away: "Serbien", pred: { home: 2, away: 0 } },
    { home: "Sverige", away: "Schweiz", pred: { home: 1, away: 0 } },
    { home: "Brasilien", away: "Sverige", pred: { home: 1, away: 0 } },
    { home: "Serbien", away: "Schweiz", pred: { home: 1, away: 1 } },
    { home: "Brasilien", away: "Schweiz", pred: { home: 3, away: 0 } },
    { home: "Serbien", away: "Sverige", pred: { home: 0, away: 2 } },
  ]);
  assert.equal(table[0].team, "Brasilien"); // 9 p
  assert.equal(table[1].team, "Sverige"); // 6 p
});

test("scoreGroupPlacements: 2 p rätt etta + 1 p rätt tvåa", () => {
  const predicted = [
    { group: "A", first: "Brasilien", second: "Sverige" },
    { group: "B", first: "Spanien", second: "Kroatien" },
  ];
  const actual = new Map([
    ["A", { first: "Brasilien", second: "Serbien" }], // etta rätt (2), tvåa fel (0)
    ["B", { first: "Spanien", second: "Kroatien" }], // båda rätt (2+1)
  ]);
  assert.equal(scoreGroupPlacements(predicted, actual), 2 + 3);
});

// ── Slutspel + bonus enligt PDF-vikter ────────────────────────────────────────
test("scoreKnockout: PDF-vikter (2/2/2/4/6/10) + skyttekung 8", () => {
  const pred: KnockoutPrediction = {
    teamsByRound: {
      R32: ["Sverige", "Brasilien", "Spanien"],
      R16: ["Brasilien", "Spanien"],
      QF: ["Spanien"],
      SF: ["Spanien"],
      FINAL: ["Spanien"],
      CHAMPION: ["Spanien"],
    },
    champion: "Spanien",
    topScorer: "Kylian Mbappé",
    topScorerGoals: 8,
    totalGoals: 281,
  };
  const actual = {
    teamsByRound: { R32: new Set(["Sverige", "Spanien"]), R16: new Set(["Spanien"]), QF: new Set(["Spanien"]) },
    champion: "Spanien",
    topScorer: "Kylian Mbappé",
    topScorerGoals: 7, // fel antal
  };
  // R32: 2 lag * 2 = 4 ; R16: 1*2 = 2 ; QF: 1*2 = 2 ; mästare 10 ; skyttekung 8 ; antal fel = 0
  assert.equal(scoreKnockout(pred, actual), 4 + 2 + 2 + 10 + 8);
});

test("scoreKnockout: rätt antal mål ger 5 p OBEROENDE av rätt skyttekung", () => {
  const pred: KnockoutPrediction = {
    teamsByRound: { R32: [], R16: [], QF: [], SF: [], FINAL: [], CHAMPION: [] },
    champion: "",
    topScorer: "Fel Spelare",
    topScorerGoals: 7,
    totalGoals: 0,
  };
  const actual = { teamsByRound: {}, topScorer: "Annan Spelare", topScorerGoals: 7 };
  assert.equal(scoreKnockout(pred, actual), 5); // skyttekung fel (0) men antal rätt (5)
});
