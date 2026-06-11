import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLiveSnapshot, finalizeGone } from "../src/engine.ts";
import type { LiveMatch } from "../src/types.ts";

function lm(id: number, h: string, a: string, score: [number, number], status: string, elapsed = 45): LiveMatch {
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
  };
}
const keyOf = (m: LiveMatch) => String(m.fixtureId);

test("baseline: första gången en match ses annonseras inget", () => {
  const r = applyLiveSnapshot({}, [], [lm(1, "A", "B", [1, 0], "1H")], keyOf);
  assert.equal(r.changes.length, 0);
  assert.equal(r.results["1"].score.home, 1);
  assert.deepEqual(r.liveKeys, ["1"]);
});

test("mål upptäcks vid ökning", () => {
  const a = applyLiveSnapshot({}, [], [lm(1, "A", "B", [0, 0], "1H")], keyOf);
  const b = applyLiveSnapshot(a.results, a.liveKeys, [lm(1, "A", "B", [1, 0], "1H", 23)], keyOf);
  assert.equal(b.changes.length, 1);
  assert.equal(b.changes[0].disallowed, false);
  assert.deepEqual(b.changes[0].match.score, { home: 1, away: 0 });
});

test("VAR-underkänt mål: ställningen ned => disallowed", () => {
  const a = applyLiveSnapshot({}, [], [lm(1, "A", "B", [2, 0], "2H")], keyOf);
  const b = applyLiveSnapshot(a.results, a.liveKeys, [lm(1, "A", "B", [1, 0], "2H", 72)], keyOf);
  assert.equal(b.changes.length, 1);
  assert.equal(b.changes[0].disallowed, true);
});

test("ingen ändring när bara statusen ändras (t.ex. 1H -> HT)", () => {
  const a = applyLiveSnapshot({}, [], [lm(1, "A", "B", [1, 0], "1H")], keyOf);
  const b = applyLiveSnapshot(a.results, a.liveKeys, [lm(1, "A", "B", [1, 0], "HT")], keyOf);
  assert.equal(b.changes.length, 0);
  assert.equal(b.results["1"].status, "HT");
});

test("match som faller ur live finaliseras", () => {
  const a = applyLiveSnapshot({}, [], [lm(1, "A", "B", [2, 1], "2H", 90)], keyOf);
  const b = applyLiveSnapshot(a.results, a.liveKeys, [], keyOf);
  assert.deepEqual(b.goneKeys, ["1"]);
  const changes = finalizeGone(b.results, b.goneKeys, new Map([["1", null]]));
  assert.equal(changes.length, 1);
  assert.equal(changes[0].finished, true);
  assert.equal(b.results["1"].final, true);
  assert.deepEqual(b.results["1"].score, { home: 2, away: 1 });
});
