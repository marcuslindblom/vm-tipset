import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLiveSnapshot, finalizeGone, diffEvents } from "../src/engine.ts";
import type { LiveMatch, MatchEvent } from "../src/types.ts";

function lm(
  id: number,
  h: string,
  a: string,
  score: [number, number],
  status: string,
  elapsed = 45,
  events: MatchEvent[] = [],
): LiveMatch {
  return {
    fixtureId: id,
    leagueId: 1,
    round: "",
    date: "",
    home: { id: 1, name: h },
    away: { id: 2, name: a },
    score: { home: score[0], away: score[1] },
    status,
    elapsed,
    events,
  };
}
const keyOf = (m: LiveMatch) => String(m.fixtureId);

test("baseline: första gången en match ses annonseras inget", () => {
  const r = applyLiveSnapshot({}, [], [lm(1, "A", "B", [1, 0], "1H")], keyOf);
  assert.equal(r.changes.length, 0);
  assert.equal(r.results["1"].score.home, 1);
});

test("avspark: matchen ses tidigt i 1H => kickoff-händelse", () => {
  const r = applyLiveSnapshot({}, [], [lm(1, "A", "B", [0, 0], "1H", 1)], keyOf);
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].kind, "kickoff");
});

test("ingen avspark om matchen ses sent (start mitt i match)", () => {
  const r = applyLiveSnapshot({}, [], [lm(1, "A", "B", [1, 1], "1H", 30)], keyOf);
  assert.equal(r.changes.length, 0);
});

test("mål upptäcks vid ökning, med målskytt från events", () => {
  const goalEv: MatchEvent = { type: "Goal", detail: "Normal Goal", team: "A", player: "Zlatan", assist: "Forsberg", elapsed: 23 };
  const a = applyLiveSnapshot({}, [], [lm(1, "A", "B", [0, 0], "1H")], keyOf);
  const b = applyLiveSnapshot(a.results, a.liveKeys, [lm(1, "A", "B", [1, 0], "1H", 23, [goalEv])], keyOf);
  assert.equal(b.changes.length, 1);
  assert.equal(b.changes[0].kind, "goal");
  assert.equal(b.changes[0].scorer, "Zlatan");
  assert.equal(b.changes[0].assist, "Forsberg");
});

test("VAR-underkänt mål: ställningen ned => kind disallowed", () => {
  const a = applyLiveSnapshot({}, [], [lm(1, "A", "B", [2, 0], "2H")], keyOf);
  const b = applyLiveSnapshot(a.results, a.liveKeys, [lm(1, "A", "B", [1, 0], "2H", 72)], keyOf);
  assert.equal(b.changes[0].kind, "disallowed");
});

test("halvtid: 1H -> HT ger en halftime-händelse", () => {
  const a = applyLiveSnapshot({}, [], [lm(1, "A", "B", [1, 0], "1H")], keyOf);
  const b = applyLiveSnapshot(a.results, a.liveKeys, [lm(1, "A", "B", [1, 0], "HT")], keyOf);
  assert.equal(b.changes.length, 1);
  assert.equal(b.changes[0].kind, "halftime");
});

test("annan statusövergång (2H -> ET) ger ingen händelse", () => {
  const a = applyLiveSnapshot({}, [], [lm(1, "A", "B", [1, 1], "2H")], keyOf);
  const b = applyLiveSnapshot(a.results, a.liveKeys, [lm(1, "A", "B", [1, 1], "ET")], keyOf);
  assert.equal(b.changes.length, 0);
});

test("match som faller ur live finaliseras => kind fulltime", () => {
  const a = applyLiveSnapshot({}, [], [lm(1, "A", "B", [2, 1], "2H", 90)], keyOf);
  const b = applyLiveSnapshot(a.results, a.liveKeys, [], keyOf);
  assert.deepEqual(b.goneKeys, ["1"]);
  const changes = finalizeGone(b.results, b.goneKeys, new Map([["1", null]]));
  assert.equal(changes[0].kind, "fulltime");
  assert.equal(b.results["1"].final, true);
});

test("diffEvents: rött kort fångas, men gamla events vid baseline annonseras inte", () => {
  const red: MatchEvent = { type: "Card", detail: "Red Card", team: "B", player: "Busta", elapsed: 50 };
  const m1 = lm(1, "A", "B", [0, 0], "2H", 50, [red]);
  // Första gången matchen ses (baseline) => seeda tyst.
  const first = diffEvents(new Set(), [m1], keyOf, new Set(["1"]));
  assert.equal(first.changes.length, 0);
  // Nytt rött kort i nästa poll (inte baseline) => annonseras.
  const red2: MatchEvent = { type: "Card", detail: "Second Yellow card", team: "A", player: "Larsson", elapsed: 70 };
  const m2 = lm(1, "A", "B", [0, 0], "2H", 70, [red, red2]);
  const second = diffEvents(first.seen, [m2], keyOf, new Set());
  assert.equal(second.changes.length, 1);
  assert.equal(second.changes[0].kind, "redcard");
  assert.equal(second.changes[0].scorer, "Larsson");
});
