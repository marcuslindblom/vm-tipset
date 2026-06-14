// Ren ändrings- och händelsedetektering – ingen I/O, delas av Durable Object och simulatorn.

import type { LiveMatch, MatchEvent, MatchResult, Score } from "./types";
import { isFinal } from "./types";

export type ChangeKind =
  | "kickoff"
  | "goal"
  | "disallowed" // VAR-underkänt (ställningen ned)
  | "halftime"
  | "fulltime"
  | "redcard"
  | "penalty_missed";

// Avspark = matchen ses första gången tidigt i första halvlek (inte ett mid-match-uppvaknande).
const KICKOFF_ELAPSED_MAX = 5;

export interface Change {
  key: string;
  match: LiveMatch;
  prev: Score;
  kind: ChangeKind;
  scorer?: string; // målskytt eller utvisad/missande spelare
  assist?: string; // assist (för mål)
  detail?: string; // "Penalty", "Own Goal", "Second Yellow card" …
  team?: string; // lag för kort/straff
}

export interface DiffResult {
  results: Record<string, MatchResult>;
  liveKeys: string[];
  changes: Change[];
  goneKeys: string[];
}

function toResult(m: LiveMatch, final: boolean): MatchResult {
  return { fixtureId: m.fixtureId, home: m.home.name, away: m.away.name, score: m.score, status: m.status, final };
}

export function resultToLive(r: MatchResult): LiveMatch {
  return {
    fixtureId: r.fixtureId,
    leagueId: 0,
    round: "",
    date: "",
    home: { id: 0, name: r.home },
    away: { id: 0, name: r.away },
    score: r.score,
    status: r.status,
    elapsed: null,
  };
}

/** Senaste målskytt för en sida (utifrån events), för en snyggare notis. */
function goalScorer(m: LiveMatch, side: "home" | "away"): { player?: string; detail?: string; assist?: string } {
  const team = side === "home" ? m.home.name : m.away.name;
  const goals = (m.events ?? [])
    .filter((e) => e.type === "Goal" && e.team === team)
    .sort((a, b) => (b.elapsed ?? 0) - (a.elapsed ?? 0));
  const g = goals[0];
  return g ? { player: g.player || undefined, detail: g.detail || undefined, assist: g.assist } : {};
}

/**
 * Applicera ett live-snapshot: upptäck mål (upp/ned) och halvtid.
 * Första gången en match ses sparas ställningen tyst.
 */
export function applyLiveSnapshot(
  prevResults: Record<string, MatchResult>,
  prevLiveKeys: string[],
  live: LiveMatch[],
  keyOf: (m: LiveMatch) => string,
): DiffResult {
  const results: Record<string, MatchResult> = { ...prevResults };
  const liveKeys: string[] = [];
  const changes: Change[] = [];

  for (const m of live) {
    const key = keyOf(m);
    liveKeys.push(key);
    const prev = results[key];
    if (!prev) {
      results[key] = toResult(m, false); // baseline
      // Avspark bara om vi fångar matchen tidigt i 1:a halvlek (inte en match som
      // redan rullat länge när tjänsten startar mitt i).
      if (m.status === "1H" && (m.elapsed == null || m.elapsed <= KICKOFF_ELAPSED_MAX)) {
        changes.push({ key, match: m, prev: m.score, kind: "kickoff" });
      }
      continue;
    }
    const goal = prev.score.home !== m.score.home || prev.score.away !== m.score.away;
    if (goal) {
      const newTotal = m.score.home + m.score.away;
      const oldTotal = prev.score.home + prev.score.away;
      if (newTotal < oldTotal) {
        changes.push({ key, match: m, prev: prev.score, kind: "disallowed" });
      } else {
        const side = m.score.home > prev.score.home ? "home" : "away";
        const { player, detail, assist } = goalScorer(m, side);
        changes.push({ key, match: m, prev: prev.score, kind: "goal", scorer: player, detail, assist });
      }
      results[key] = toResult(m, false);
    } else if (prev.status !== m.status) {
      if (m.status === "HT" && prev.status !== "HT") {
        changes.push({ key, match: m, prev: prev.score, kind: "halftime" });
      }
      results[key] = toResult(m, false);
    }
  }

  const liveSet = new Set(liveKeys);
  const goneKeys: string[] = [];
  for (const key of prevLiveKeys) {
    if (liveSet.has(key)) continue;
    const prev = results[key];
    if (prev && !prev.final) goneKeys.push(key);
  }

  return { results, liveKeys, changes, goneKeys };
}

export interface FinalizeResult {
  changes: Change[];
  /** Matcher som lämnat live men där fixtures-feeden ännu visar pågående (blip/eftersläpning)
   *  => lås INTE fast som final; fortsätt bevaka så FT postas korrekt när matchen verkligen är slut. */
  keepLive: string[];
}

/**
 * Finalisera matcher som fallit ur live-listan.
 * - fixtures-feeden bekräftar slut (FT/AET/PEN) => finalisera med slutresultatet, posta FT.
 * - hämtning misslyckades (null) => matchen är borta ur live; finalisera med senast sedda ställning.
 * - fixtures-feeden visar ännu pågående (t.ex. "2H") => eventual consistency mellan live- och
 *   fixtures-feeden; behåll bevakning i stället för att låsa fast den som final (annars tappas
 *   den ur liveKeys och finaliseras aldrig).
 */
export function finalizeGone(
  results: Record<string, MatchResult>,
  goneKeys: string[],
  fetched: Map<string, LiveMatch | null>,
): FinalizeResult {
  const changes: Change[] = [];
  const keepLive: string[] = [];
  for (const key of goneKeys) {
    const prev = results[key];
    if (!prev || prev.final) continue;
    const fin = fetched.get(key) ?? null;
    if (fin && !isFinal(fin.status)) {
      keepLive.push(key);
      continue;
    }
    if (fin) {
      results[key] = toResult(fin, true);
      changes.push({ key, match: fin, prev: prev.score, kind: "fulltime" });
    } else {
      results[key] = { ...prev, final: true };
      changes.push({ key, match: resultToLive(prev), prev: prev.score, kind: "fulltime" });
    }
  }
  return { changes, keepLive };
}

// ── Händelse-diff (röda kort, missade straffar …) ─────────────────────────────
// Mål hanteras via målställningen ovan; här fångar vi övriga dramatiska händelser.

export function eventSignature(key: string, e: MatchEvent): string {
  return `${key}|${e.elapsed ?? "?"}|${e.type}|${e.detail}|${e.team}|${e.player}`;
}

function notableKind(e: MatchEvent): ChangeKind | null {
  if (e.type === "Card" && /red|second yellow/i.test(e.detail)) return "redcard";
  if (e.type === "Goal" && /missed penalty/i.test(e.detail)) return "penalty_missed";
  return null;
}

/**
 * Hitta nya, anmärkningsvärda händelser sedan förra pollningen.
 * `seen` är signaturer vi redan reagerat på; returnerar nya changes + uppdaterad mängd.
 */
export function diffEvents(
  seen: Set<string>,
  live: LiveMatch[],
  keyOf: (m: LiveMatch) => string,
  baselineKeys: Set<string>, // matcher som ses för första gången => seeda tyst
): { changes: Change[]; seen: Set<string> } {
  const changes: Change[] = [];
  const next = new Set(seen);
  for (const m of live) {
    const key = keyOf(m);
    const isBaseline = baselineKeys.has(key);
    for (const e of m.events ?? []) {
      const sig = eventSignature(key, e);
      if (next.has(sig)) continue;
      next.add(sig);
      if (isBaseline) continue; // förstagångssikt: registrera men annonsera inte gammalt
      const kind = notableKind(e);
      if (!kind) continue;
      changes.push({ key, match: m, prev: m.score, kind, scorer: e.player || undefined, detail: e.detail, team: e.team });
    }
  }
  return { changes, seen: next };
}
