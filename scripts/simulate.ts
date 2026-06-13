// E2E-simulering UTAN API/Slack: spelar upp en matchdag genom exakt samma motor som
// Durable Object (engine + scoring + commentary + slack-builder), med riktiga 2026-matcher,
// Marcus riktiga tips + syntetiska motspelare, målskyttar, ett rött kort — och Arnes
// AI-referat (om GOOGLE_GENERATIVE_AI_API_KEY finns i .dev.vars).
//
//   npm run simulate

import { readFileSync } from "node:fs";
import {
  players as realPlayers,
  predictionsByMatch,
  keyOfLive,
  displayNames,
  fixtures,
} from "../src/predictions.ts";
import { applyLiveSnapshot, finalizeGone, diffEvents, type Change } from "../src/engine.ts";
import { computeStandings, gradeMatch, isExact, type Prediction } from "../src/scoring.ts";
import { headline, standingsText, matchPointsText, statsSummary, type GoalView, type MatchPointRow } from "../src/slack.ts";
import { generateCommentary, type CommentaryContext, type TipperView } from "../src/commentary.ts";
import type { Env, LiveMatch, MatchEvent, MatchResult, MatchStats, Score } from "../src/types.ts";

// Bygg en minimal env från .dev.vars (för Arnes referat).
function devEnv(): Env {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(".dev.vars", "utf8").split("\n")) {
      const m = /^\s*([A-Z_]+)\s*=\s*(.+)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch {}
  return { GEMINI_MODEL: out.GEMINI_MODEL || "gemini-3.5-flash", GOOGLE_GENERATIVE_AI_API_KEY: out.GOOGLE_GENERATIVE_AI_API_KEY } as Env;
}
const env = devEnv();

function findKey(homeSv: string, awaySv: string): string {
  for (const [key, f] of Object.entries(fixtures)) if (f.homeSv === homeSv && f.awaySv === awaySv) return key;
  throw new Error(`hittade ingen match ${homeSv} - ${awaySv}`);
}

const A = findKey("Mexiko", "Sydafrika"); // Marcus 2-0
const B = findKey("Spanien", "Kap Verde"); // Marcus 3-0
const C = findKey("Sverige", "Tunisien"); // Marcus 1-0

const SYNTH: Record<string, Record<string, Prediction>> = {
  Anna: { [A]: { home: 1, away: 1 }, [B]: { home: 1, away: 1 }, [C]: { home: 1, away: 1 } },
  Erik: { [A]: { home: 2, away: 1 }, [B]: { home: 2, away: 0 }, [C]: { home: 0, away: 0 } },
  Johan: { [A]: { home: 0, away: 2 }, [B]: { home: 1, away: 1 }, [C]: { home: 2, away: 1 } },
};
const allPlayers = [...realPlayers, ...Object.keys(SYNTH)];
const preds = predictionsByMatch();
for (const [player, byKey] of Object.entries(SYNTH))
  for (const [key, p] of Object.entries(byKey)) {
    if (!preds.has(key)) preds.set(key, new Map());
    preds.get(key)!.set(player, p);
  }

// Syntetisk lagstatistik per match (motsvarar /fixtures/statistics) för HT/FT-fakta.
const STATS: Record<string, MatchStats> = {
  [A]: {
    home: { possession: "55%", totalShots: 12, shotsOnGoal: 5, corners: 5, saves: 3, xg: "1.8" },
    away: { possession: "45%", totalShots: 9, shotsOnGoal: 4, corners: 3, saves: 4, xg: "1.3" },
  },
  [B]: {
    home: { possession: "71%", totalShots: 18, shotsOnGoal: 8, corners: 9, saves: 1, xg: "2.9" },
    away: { possession: "29%", totalShots: 4, shotsOnGoal: 1, corners: 1, saves: 6, xg: "0.3" },
  },
  [C]: {
    home: { possession: "64%", totalShots: 14, shotsOnGoal: 3, corners: 7, saves: 2, xg: "1.1" },
    away: { possession: "36%", totalShots: 5, shotsOnGoal: 2, corners: 2, saves: 3, xg: "0.6" },
  },
};

// Aktuellt läge per match: ställning, minut, status, events.
const cur: Record<string, { h: number; a: number; min: number; status: string; events: MatchEvent[] }> = {
  [A]: { h: 0, a: 0, min: 0, status: "1H", events: [] },
  [B]: { h: 0, a: 0, min: 0, status: "1H", events: [] },
  [C]: { h: 0, a: 0, min: 0, status: "1H", events: [] },
};
function live(key: string): LiveMatch {
  const f = fixtures[key];
  return {
    fixtureId: f.fixtureId ?? 0,
    leagueId: 1,
    round: `Group ${f.group}`,
    date: "",
    home: { id: 0, name: f.home },
    away: { id: 0, name: f.away },
    score: { home: cur[key].h, away: cur[key].a },
    status: cur[key].status,
    elapsed: cur[key].min,
    events: cur[key].events,
  };
}
function snapshot(keys: string[]): LiveMatch[] {
  return keys.map(live);
}

// ── Harness som speglar Durable Object.process() ──────────────────────────────
let results: Record<string, MatchResult> = {};
let liveKeys: string[] = [];
let seen = new Set<string>();
let ranking: Record<string, number> = {};
const scoreMap = (r: Record<string, MatchResult>) => new Map(Object.entries(r).map(([k, v]) => [k, v.score]));

async function tick(active: string[]): Promise<void> {
  const snap = snapshot(active);
  const baseline = new Set(snap.map(keyOfLive).filter((k) => !results[k]));
  const diff = applyLiveSnapshot(results, liveKeys, snap, keyOfLive);
  const finals = finalizeGone(diff.results, diff.goneKeys, new Map(diff.goneKeys.map((k) => [k, null])));
  const ev = diffEvents(seen, snap, keyOfLive, baseline);
  results = diff.results;
  liveKeys = diff.liveKeys;
  seen = ev.seen;
  const changes: Change[] = [...diff.changes, ...ev.changes, ...finals];
  if (!changes.length) return;

  const standings = computeStandings(allPlayers, preds, scoreMap(results), new Map(), new Map(Object.entries(ranking)));
  const leader = standings[0]?.player;
  const movers = standings.filter((r) => r.delta !== 0).slice(0, 3).map((r) => `${r.player} ${r.delta > 0 ? "▲" + r.delta : "▼" + -r.delta}`).join(", ");

  for (const c of changes) {
    const names = displayNames(c.key, c.match);
    const tippers: TipperView[] = [];
    for (const [player, p] of preds.get(c.key) ?? []) {
      const outcome = isExact(p, c.match.score) ? "exakt" : gradeMatch(p, c.match.score) > 0 ? "rätt tecken" : "fel";
      tippers.push({ player, pred: `${p.home}-${p.away}`, outcome });
    }
    const statsText =
      (c.kind === "halftime" || c.kind === "fulltime") && STATS[c.key]
        ? (statsSummary(names.home, names.away, STATS[c.key]) ?? undefined)
        : undefined;
    const ctx: CommentaryContext = {
      kind: c.kind, home: names.home, away: names.away, score: c.match.score, prev: c.prev, minute: c.match.elapsed,
      round: `Grupp ${fixtures[c.key].group}`, scorer: c.scorer, assist: c.assist, detail: c.detail, team: c.team, tippers, leader, movers, statsText,
    };
    const commentary = await generateCommentary(env, ctx);
    const allTips =
      c.kind === "kickoff"
        ? allPlayers
            .map((pl) => {
              const p = preds.get(c.key)?.get(pl);
              return p ? `${pl} ${p.home}-${p.away}` : null;
            })
            .filter(Boolean)
            .join(" · ")
        : undefined;
    const view: GoalView = { kind: c.kind, homeName: names.home, awayName: names.away, score: c.match.score, minute: c.match.elapsed, scorer: c.scorer, detail: c.detail, team: c.team, context: `Grupp ${fixtures[c.key].group} · VM 2026`, allTips, statsText, commentary };
    if (c.kind === "fulltime") {
      const mp: MatchPointRow[] = [...(preds.get(c.key) ?? [])]
        .map(([player, p]) => ({ player, points: gradeMatch(p, c.match.score) }))
        .sort((a, b) => b.points - a.points);
      render(view, commentary, { matchPoints: mp, standings });
    } else {
      render(view, commentary, null);
    }
  }
  if (changes.some((c) => c.kind === "fulltime")) ranking = Object.fromEntries(standings.map((r) => [r.player, r.rank]));
}

function render(
  view: GoalView,
  commentary: string | null,
  ft: { matchPoints: MatchPointRow[]; standings: any[] } | null,
): void {
  console.log("\n┌─ Slack → #vm-tipset " + "─".repeat(44));
  if (view.context) console.log("│ " + view.context);
  console.log("│ " + headline(view));
  if (commentary) for (const l of wrap(`🎙️ ${commentary} — Arne`, 60)) console.log("│ " + l);
  if (view.statsText) {
    console.log("│ 📈 Matchfakta:");
    for (const l of wrap(view.statsText, 60)) console.log("│   " + l);
  }
  if (view.allTips) {
    console.log("│ 🎲 Allas tips:");
    for (const l of wrap(view.allTips, 60)) console.log("│   " + l);
  }
  if (ft) {
    console.log("│ ⚽ Den här matchen gav:");
    for (const l of matchPointsText(ft.matchPoints).split("\n")) console.log("│   " + l);
    console.log("│ 📊 Totalställning i VM-tipset");
    for (const l of standingsText(ft.standings).split("\n")) console.log("│   " + l);
  }
  console.log("└" + "─".repeat(65));
}
function wrap(s: string, w: number): string[] {
  const words = s.split(" "), out: string[] = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > w) { out.push(line.trim()); line = word; } else line += " " + word;
  }
  if (line.trim()) out.push(line.trim());
  return out;
}

// Hjälpare för att lägga mål/kort med skytt.
function goal(key: string, h: number, a: number, min: number, scorer: string, team: "home" | "away", assist?: string): void {
  cur[key].h = h; cur[key].a = a; cur[key].min = min; cur[key].status = min > 45 ? "2H" : "1H";
  cur[key].events.push({ type: "Goal", detail: "Normal Goal", team: fixtures[key][team === "home" ? "home" : "away"], player: scorer, assist, elapsed: min });
}
function redCard(key: string, min: number, player: string, team: "home" | "away"): void {
  cur[key].min = min; cur[key].status = min > 45 ? "2H" : "1H";
  cur[key].events.push({ type: "Card", detail: "Red Card", team: fixtures[key][team === "home" ? "home" : "away"], player, elapsed: min });
}
function halftime(keys: string[]): void {
  for (const k of keys) { cur[k].status = "HT"; cur[k].min = 45; }
}

// ── Scenario ──────────────────────────────────────────────────────────────────
console.log("VM-tipset – E2E-simulering med Arnes AI-referat" + (env.GOOGLE_GENERATIVE_AI_API_KEY ? "" : "  (ingen Gemini-nyckel → utan referat)"));
console.log("Spelare:", allPlayers.join(", "), " (Anna/Erik/Johan = syntetiska)\n");

const all = [A, B, C];
await tick(all); // baseline

goal(B, 1, 0, 12, "Lamine Yamal", "home", "Pedri"); await tick(all);
goal(A, 1, 0, 23, "J. Quiñones", "home"); await tick(all);
redCard(C, 38, "M. Daoud", "away"); await tick(all);
goal(A, 1, 1, 41, "P. Mahlambi", "away"); await tick(all);
halftime(all); await tick(all); // ← halvtid (visar matchfakta)
goal(B, 2, 0, 55, "Á. Morata", "home"); await tick(all);
goal(A, 2, 1, 67, "R. Jiménez", "home", "R. Alvarado"); await tick(all);
goal(B, 3, 0, 78, "Nico Williams", "home"); await tick(all);

console.log("\n— matcherna slutspelas —");
await tick([]);

console.log("\n=== Slutställning ===");
for (const r of computeStandings(allPlayers, preds, scoreMap(results)))
  console.log(`  ${r.rank}. ${r.player.padEnd(8)} ${String(r.points).padStart(2)} p (${r.exact} exakta)`);
