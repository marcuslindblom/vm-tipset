// Ren ändringsdetektering – ingen I/O, delas av Durable Object och simulatorn.
// Tar ett live-snapshot, jämför mot lagrade resultat, returnerar nya resultat + förändringar.

import type { LiveMatch, MatchResult, Score } from "./types";
import { isFinal } from "./types";

export interface Change {
  key: string;
  match: LiveMatch;
  prev: Score;
  disallowed: boolean; // ställningen gick ned (VAR-underkänt mål)
  finished: boolean;
}

export interface DiffResult {
  results: Record<string, MatchResult>;
  liveKeys: string[];
  changes: Change[];
  goneKeys: string[]; // matcher som fallit ur live-listan och behöver finaliseras
}

function toResult(m: LiveMatch, final: boolean): MatchResult {
  return {
    fixtureId: m.fixtureId,
    home: m.home.name,
    away: m.away.name,
    score: m.score,
    status: m.status,
    final,
  };
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

/**
 * Applicera ett live-snapshot.
 * – Första gången en match ses sparas ställningen tyst (vi annonserar inte mål som
 *   redan hänt innan vi började titta).
 * – Vid varje måländring (upp ELLER ned) skapas en Change.
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
      results[key] = toResult(m, false); // baseline, tyst
      continue;
    }
    const goal = prev.score.home !== m.score.home || prev.score.away !== m.score.away;
    if (goal) {
      const newTotal = m.score.home + m.score.away;
      const oldTotal = prev.score.home + prev.score.away;
      changes.push({ key, match: m, prev: prev.score, disallowed: newTotal < oldTotal, finished: false });
      results[key] = toResult(m, false);
    } else if (prev.status !== m.status) {
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

/**
 * Finalisera matcher som fallit ur live-listan.
 * `fetched` = ev. hämtad slutstatus per nyckel (null om vi inte kunde hämta – då
 * låses senast kända ställning som slutresultat).
 */
export function finalizeGone(
  results: Record<string, MatchResult>,
  goneKeys: string[],
  fetched: Map<string, LiveMatch | null>,
): Change[] {
  const changes: Change[] = [];
  for (const key of goneKeys) {
    const prev = results[key];
    if (!prev || prev.final) continue;
    const fin = fetched.get(key) ?? null;
    if (fin) {
      results[key] = toResult(fin, isFinal(fin.status));
      if (isFinal(fin.status)) {
        changes.push({ key, match: fin, prev: prev.score, disallowed: false, finished: true });
      }
    } else {
      results[key] = { ...prev, final: true };
      changes.push({ key, match: resultToLive(prev), prev: prev.score, disallowed: false, finished: true });
    }
  }
  return changes;
}
