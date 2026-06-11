// E2E-simulering UTAN API/Slack: spelar upp en matchdag mål-för-mål genom exakt
// samma motor som Durable Object kör (engine + scoring + slack-builder), med riktiga
// 2026-matcher och Marcus riktiga tips + tre syntetiska motspelare. Verifierar att
// rättning, ställning, pilar och Slack-formattering blir rätt.
//
//   npm run simulate

import {
  players as realPlayers,
  predictionsByMatch,
  keyOfLive,
  displayNames,
  fixtures,
} from "../src/predictions.ts";
import { applyLiveSnapshot, finalizeGone, type Change } from "../src/engine.ts";
import { computeStandings, type Prediction, type StandingRow } from "../src/scoring.ts";
import { buildGoalMessage, standingsText, type GoalView } from "../src/slack.ts";
import type { LiveMatch, MatchResult, Score } from "../src/types.ts";

function findKey(homeSv: string, awaySv: string): string {
  for (const [key, f] of Object.entries(fixtures)) {
    if (f.homeSv === homeSv && f.awaySv === awaySv) return key;
  }
  throw new Error(`hittade ingen match ${homeSv} - ${awaySv}`);
}

// Tre riktiga matcher från matchdag 1.
const A = findKey("Mexiko", "Sydafrika"); // Marcus tippar 2-0
const B = findKey("Spanien", "Kap Verde"); // Marcus tippar 3-0
const C = findKey("Sverige", "Tunisien"); // Marcus tippar 1-0

// Syntetiska motspelare (Marcus tips kommer från Excel-importen).
const SYNTH: Record<string, Record<string, Prediction>> = {
  Anna: { [A]: { home: 1, away: 1 }, [B]: { home: 1, away: 1 }, [C]: { home: 1, away: 1 } },
  Erik: { [A]: { home: 2, away: 1 }, [B]: { home: 2, away: 0 }, [C]: { home: 0, away: 0 } },
  Johan: { [A]: { home: 0, away: 2 }, [B]: { home: 1, away: 1 }, [C]: { home: 2, away: 1 } },
};

const allPlayers = [...realPlayers, ...Object.keys(SYNTH)];
const preds = predictionsByMatch();
for (const [player, byKey] of Object.entries(SYNTH)) {
  for (const [key, p] of Object.entries(byKey)) {
    if (!preds.has(key)) preds.set(key, new Map());
    preds.get(key)!.set(player, p);
  }
}

// Bygg en LiveMatch utifrån en match i tipsdatan.
function live(key: string, home: number, away: number, status: string, min: number): LiveMatch {
  const f = fixtures[key];
  return {
    fixtureId: f.fixtureId ?? 0,
    leagueId: 1,
    round: `Group ${f.group}`,
    date: "",
    home: { id: 0, name: f.home },
    away: { id: 0, name: f.away },
    score: { home, away },
    status,
    elapsed: min,
  };
}

// Aktuell ställning per match; varje event uppdaterar en match och bygger ett snapshot.
const cur: Record<string, { h: number; a: number; min: number; status: string }> = {
  [A]: { h: 0, a: 0, min: 0, status: "1H" },
  [B]: { h: 0, a: 0, min: 0, status: "1H" },
  [C]: { h: 0, a: 0, min: 0, status: "1H" },
};
function snapshot(keys: string[]): LiveMatch[] {
  return keys.map((k) => live(k, cur[k].h, cur[k].a, cur[k].status, cur[k].min));
}

// ── Harness som speglar Durable Object.process() ──────────────────────────────
let results: Record<string, MatchResult> = {};
let liveKeys: string[] = [];
let ranking: Record<string, number> = {};

function scoreMap(r: Record<string, MatchResult>): Map<string, Score> {
  return new Map(Object.entries(r).map(([k, v]) => [k, v.score]));
}

function tick(activeKeys: string[]): void {
  const snap = snapshot(activeKeys);
  const diff = applyLiveSnapshot(results, liveKeys, snap, keyOfLive);
  const finals = finalizeGone(diff.results, diff.goneKeys, new Map(diff.goneKeys.map((k) => [k, null])));
  results = diff.results;
  liveKeys = diff.liveKeys;
  const changes: Change[] = [...diff.changes, ...finals];
  if (changes.length === 0) return;

  const standings = computeStandings(
    allPlayers,
    preds,
    scoreMap(results),
    new Map(),
    new Map(Object.entries(ranking)),
  );

  for (const c of changes) {
    const names = displayNames(c.key, c.match);
    const view: GoalView = {
      homeName: names.home,
      awayName: names.away,
      score: c.match.score,
      prevScore: c.prev,
      minute: c.match.elapsed,
      finished: c.finished,
      disallowed: c.disallowed,
    };
    const msg = buildGoalMessage(view, standings);
    render(msg.text, standings);
  }
  ranking = Object.fromEntries(standings.map((r) => [r.player, r.rank]));
}

function render(title: string, standings: StandingRow[]): void {
  console.log("\n┌─ Slack → #vm-tipset " + "─".repeat(40));
  console.log("│ " + title);
  console.log("│ 🏆 Ställning (live)");
  for (const line of standingsText(standings).split("\n")) console.log("│   " + line);
  console.log("└" + "─".repeat(61));
}

function goal(key: string, h: number, a: number, min: number): void {
  cur[key] = { h, a, min, status: min > 45 ? "2H" : "1H" };
}

// ── Scenario: matchdag med tre samtidiga matcher ──────────────────────────────
console.log("VM-tipset – E2E-simulering (riktiga matcher + Marcus riktiga tips)\n");
console.log("Spelare:", allPlayers.join(", "), "  (Anna/Erik/Johan = syntetiska motspelare)");
console.log("Matcher:");
for (const k of [A, B, C]) console.log(`  ${fixtures[k].homeSv} – ${fixtures[k].awaySv}  (Marcus: ${preds.get(k)!.get("Marcus")!.home}-${preds.get(k)!.get("Marcus")!.away})`);

const all = [A, B, C];
tick(all); // baseline 0-0, ingen post

goal(B, 1, 0, 12); tick(all);
goal(A, 1, 0, 23); tick(all);
goal(C, 1, 0, 33); tick(all);
goal(A, 1, 1, 41); tick(all);
goal(B, 2, 0, 55); tick(all);
goal(A, 2, 1, 67); tick(all);
goal(C, 2, 0, 70); tick(all); // mål...
goal(C, 1, 0, 72); tick(all); // ...som underkänns av VAR
goal(B, 3, 0, 78); tick(all);

// Matcherna spelas färdigt och faller ur live-listan => slutresultat postas.
console.log("\n— matcherna slutspelas (faller ur live=all) —");
tick([]);

console.log("\n=== Slutställning ===");
for (const r of computeStandings(allPlayers, preds, scoreMap(results))) {
  console.log(`  ${r.rank}. ${r.player.padEnd(8)} ${String(r.points).padStart(2)} p  (grupp ${r.groupPoints}, ${r.exact} exakta)`);
}
