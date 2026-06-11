import { test } from "node:test";
import assert from "node:assert/strict";
import { scheduleState, toKickoffMs } from "../src/schedule.ts";

const H = 3600_000;
const M = 60_000;

test("anyLive=false före lead-fönstret, men nästa avspark pekas ut", () => {
  const k = [10 * H];
  const s = scheduleState(k, 5 * H, 130 * M, 60_000);
  assert.equal(s.anyLive, false);
  assert.equal(s.nextKickoffMs, 10 * H);
});

test("anyLive=true strax före avspark (inom lead)", () => {
  const k = [10 * H];
  const s = scheduleState(k, 10 * H - 30_000, 130 * M, 60_000);
  assert.equal(s.anyLive, true);
});

test("anyLive=true under matchen", () => {
  const k = [10 * H];
  const s = scheduleState(k, 10 * H + 60 * M, 130 * M, 60_000);
  assert.equal(s.anyLive, true);
});

test("anyLive=false efter fönstret stängt", () => {
  const k = [10 * H];
  const s = scheduleState(k, 10 * H + 131 * M, 130 * M, 60_000);
  assert.equal(s.anyLive, false);
  assert.equal(s.nextKickoffMs, null); // inga fler matcher
});

test("flera matcher: live om NÅGON pågår; nästa = närmaste framtida", () => {
  const k = [2 * H, 5 * H, 8 * H];
  const s = scheduleState(k, 5 * H + 10 * M, 130 * M, 60_000);
  assert.equal(s.anyLive, true);
  assert.equal(s.nextKickoffMs, 8 * H);
});

test("toKickoffMs sorterar och hoppar över skräp", () => {
  const ms = toKickoffMs(["2026-06-11T19:00:00.000Z", "inte-ett-datum", "2026-06-10T19:00:00.000Z"]);
  assert.equal(ms.length, 2);
  assert.ok(ms[0] < ms[1]);
});
