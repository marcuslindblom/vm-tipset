import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gradeMatch,
  computeStandings,
  scoreKnockout,
  type Prediction,
  type KnockoutPrediction,
} from "../src/scoring.ts";

test("gradeMatch: exakt resultat = 5", () => {
  assert.equal(gradeMatch({ home: 2, away: 1 }, { home: 2, away: 1 }), 5);
  assert.equal(gradeMatch({ home: 0, away: 0 }, { home: 0, away: 0 }), 5);
});

test("gradeMatch: rätt målskillnad = 3", () => {
  assert.equal(gradeMatch({ home: 2, away: 1 }, { home: 3, away: 2 }), 3); // +1 vs +1
  assert.equal(gradeMatch({ home: 1, away: 1 }, { home: 2, away: 2 }), 3); // oavgjort, diff 0
});

test("gradeMatch: rätt utfall men fel målskillnad = 2", () => {
  assert.equal(gradeMatch({ home: 2, away: 0 }, { home: 1, away: 0 }), 2); // hemmavinst
  assert.equal(gradeMatch({ home: 0, away: 3 }, { home: 1, away: 2 }), 2); // bortavinst
});

test("gradeMatch: fel utfall = 0", () => {
  assert.equal(gradeMatch({ home: 2, away: 0 }, { home: 0, away: 1 }), 0);
  assert.equal(gradeMatch({ home: 1, away: 1 }, { home: 2, away: 0 }), 0);
});

test("computeStandings: summerar, sorterar och rankar med delade placeringar", () => {
  const preds = new Map<string, Map<string, Prediction>>([
    ["m1", new Map([["Anna", { home: 2, away: 1 }], ["Erik", { home: 1, away: 0 }], ["Johan", { home: 0, away: 0 }]])],
    ["m2", new Map([["Anna", { home: 1, away: 1 }], ["Erik", { home: 2, away: 2 }], ["Johan", { home: 3, away: 0 }]])],
  ]);
  // m1 slutar 2-1, m2 slutar 1-1
  const results = new Map([
    ["m1", { home: 2, away: 1 }],
    ["m2", { home: 1, away: 1 }],
  ]);
  // Anna: m1 exakt 5 + m2 exakt 5 = 10 (2 exakta)
  // Erik: m1 1-0 vs 2-1 => samma målskillnad +1 = 3 ; m2 2-2 vs 1-1 => samma målskillnad 0 = 3 ; totalt 6
  // Johan: m1 fel 0 + m2 fel 0 = 0
  const rows = computeStandings(["Anna", "Erik", "Johan"], preds, results);
  assert.deepEqual(
    rows.map((r) => [r.player, r.points, r.exact, r.rank]),
    [
      ["Anna", 10, 2, 1],
      ["Erik", 6, 0, 2],
      ["Johan", 0, 0, 3],
    ],
  );
});

test("computeStandings: lika poäng+exakta delar placering, och pilar räknas mot förra rankingen", () => {
  const preds = new Map<string, Map<string, Prediction>>([
    ["m1", new Map([["A", { home: 1, away: 0 }], ["B", { home: 1, away: 0 }], ["C", { home: 0, away: 0 }]])],
  ]);
  const results = new Map([["m1", { home: 1, away: 0 }]]);
  const prev = new Map([["A", 3], ["B", 1], ["C", 2]]);
  const rows = computeStandings(["A", "B", "C"], preds, results, new Map(), prev);
  // A och B: exakt 5 (delad 1:a). C: 0 (3:a).
  const byPlayer = new Map(rows.map((r) => [r.player, r]));
  assert.equal(byPlayer.get("A")!.rank, 1);
  assert.equal(byPlayer.get("B")!.rank, 1);
  assert.equal(byPlayer.get("C")!.rank, 3);
  assert.equal(byPlayer.get("A")!.delta, 2); // 3 -> 1, klättrat 2
  assert.equal(byPlayer.get("B")!.delta, 0); // 1 -> 1
});

test("computeStandings: extraPoints (slutspel/bonus) adderas till totalen", () => {
  const rows = computeStandings(
    ["A", "B"],
    new Map(),
    new Map(),
    new Map([["B", 12]]),
  );
  const byPlayer = new Map(rows.map((r) => [r.player, r]));
  assert.equal(byPlayer.get("B")!.points, 12);
  assert.equal(byPlayer.get("B")!.rank, 1);
  assert.equal(byPlayer.get("A")!.points, 0);
});

test("scoreKnockout: poäng per korrekt lag som nått en rond + bonus", () => {
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
    teamsByRound: {
      R32: new Set(["Sverige", "Spanien"]), // Brasilien åkte ut tidigare
      R16: new Set(["Spanien"]),
      QF: new Set(["Spanien"]),
    },
    champion: "Spanien",
    topScorer: "Kylian Mbappé",
    topScorerGoals: 7, // fel antal
    totalGoals: 281,
  };
  // R32: Sverige+Spanien = 2*1 = 2 ; R16: Spanien = 1*2 = 2 ; QF: Spanien = 1*4 = 4
  // champion Spanien = 12 ; topscorer rätt = 8 (men fel antal => ingen +4) ; totalGoals rätt = 5
  assert.equal(scoreKnockout(pred, actual), 2 + 2 + 4 + 12 + 8 + 5);
});
