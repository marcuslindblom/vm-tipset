// Rättningsmotorn – rena funktioner, helt utan I/O så de är enkla att enhetstesta.
// Poängsystem enligt VM-TIPSET 2026-PDF:en.

import type { Score } from "./types";
import { samePlayer } from "./teams";

export interface Prediction {
  home: number;
  away: number;
}

// ── Gruppmatch (rättas live) ──────────────────────────────────────────────────
//   Rätt tecken (1X2):  2 p
//   Rätt resultat:     +2 p  (oberoende rad → exakt resultat = 4 p totalt)
//   Fel tecken:         0 p
//   (Ingen målskillnads-nivå – PDF:en har den inte.)
export const MATCH_POINTS = { sign: 2, result: 2, exact: 4 } as const;

export function isExact(pred: Prediction, actual: Score): boolean {
  return pred.home === actual.home && pred.away === actual.away;
}

export function gradeMatch(pred: Prediction, actual: Score): number {
  let pts = 0;
  if (Math.sign(pred.home - pred.away) === Math.sign(actual.home - actual.away)) pts += MATCH_POINTS.sign;
  if (isExact(pred, actual)) pts += MATCH_POINTS.result;
  return pts;
}

// ── Ställning ─────────────────────────────────────────────────────────────────

export interface StandingRow {
  player: string;
  points: number; // totalt
  groupPoints: number; // gruppmatcher
  bonusPoints: number; // grupp-placering + slutspel + bonus
  exact: number; // antal exakta resultat (informativt)
  rank: number;
  prevRank: number | null;
  delta: number; // prevRank - rank  (>0 = klättrat)
}

/** Gruppmatchpoäng per spelare för alla matcher som har ett (live/slutgiltigt) resultat. */
export function computeGroupPoints(
  predictionsByMatch: Map<string, Map<string, Prediction>>,
  results: Map<string, Score>,
): Map<string, { points: number; exact: number }> {
  const out = new Map<string, { points: number; exact: number }>();
  for (const [key, score] of results) {
    const preds = predictionsByMatch.get(key);
    if (!preds) continue;
    for (const [player, pred] of preds) {
      const cur = out.get(player) ?? { points: 0, exact: 0 };
      cur.points += gradeMatch(pred, score);
      if (isExact(pred, score)) cur.exact += 1;
      out.set(player, cur);
    }
  }
  return out;
}

/**
 * Hela ställningen, sorterad och rankad.
 * `extraPoints` = grupp-placering + slutspel + bonus (0 tills de avgörs).
 * Lika poäng sorteras på namn live; den officiella skiljefrågan (utslagsfrågan,
 * totalt antal mål) tillämpas på slutställningen separat.
 */
export function computeStandings(
  players: string[],
  predictionsByMatch: Map<string, Map<string, Prediction>>,
  results: Map<string, Score>,
  extraPoints: Map<string, number> = new Map(),
  prevRanking: Map<string, number> | null = null,
): StandingRow[] {
  const group = computeGroupPoints(predictionsByMatch, results);

  const rows: StandingRow[] = players.map((player) => {
    const g = group.get(player) ?? { points: 0, exact: 0 };
    const bonus = extraPoints.get(player) ?? 0;
    return {
      player,
      groupPoints: g.points,
      bonusPoints: bonus,
      points: g.points + bonus,
      exact: g.exact,
      rank: 0,
      prevRank: prevRanking?.get(player) ?? null,
      delta: 0,
    };
  });

  rows.sort((a, b) => b.points - a.points || a.player.localeCompare(b.player, "sv"));

  for (let i = 0; i < rows.length; i++) {
    const prev = rows[i - 1];
    rows[i].rank = i > 0 && rows[i].points === prev.points ? prev.rank : i + 1;
  }
  for (const r of rows) r.delta = r.prevRank == null ? 0 : r.prevRank - r.rank;

  return rows;
}

export function rankingMap(rows: StandingRow[]): Map<string, number> {
  return new Map(rows.map((r) => [r.player, r.rank]));
}

// ── Grupp-placering (1:a/2:a i grupp) ─────────────────────────────────────────
export const PLACEMENT_POINTS = { first: 2, second: 1 } as const;

export interface TeamStanding {
  team: string;
  points: number;
  gd: number;
  gf: number;
}

/** Spelarens förutsagda grupptabell, härledd ur deras 6 tippade resultat i gruppen. */
export function predictedGroupTable(
  teams: string[],
  matches: { home: string; away: string; pred: Prediction }[],
): TeamStanding[] {
  const tbl = new Map<string, TeamStanding>(teams.map((t) => [t, { team: t, points: 0, gd: 0, gf: 0 }]));
  for (const m of matches) {
    const h = tbl.get(m.home);
    const a = tbl.get(m.away);
    if (!h || !a) continue;
    h.gf += m.pred.home;
    a.gf += m.pred.away;
    h.gd += m.pred.home - m.pred.away;
    a.gd += m.pred.away - m.pred.home;
    if (m.pred.home > m.pred.away) h.points += 3;
    else if (m.pred.home < m.pred.away) a.points += 3;
    else {
      h.points += 1;
      a.points += 1;
    }
  }
  return [...tbl.values()].sort(
    (x, y) => y.points - x.points || y.gd - x.gd || y.gf - x.gf || x.team.localeCompare(y.team, "sv"),
  );
}

/** 2 p per rätt gruppetta, 1 p per rätt grupptvåa. */
export function scoreGroupPlacements(
  predicted: { group: string; first: string; second: string }[],
  actual: Map<string, { first: string; second: string }>,
  weights = PLACEMENT_POINTS,
): number {
  let pts = 0;
  for (const p of predicted) {
    const a = actual.get(p.group);
    if (!a) continue;
    if (p.first === a.first) pts += weights.first;
    if (p.second === a.second) pts += weights.second;
  }
  return pts;
}

// ── Slutspel + bonus (avgörs vid matchslut/turneringsslut) ────────────────────
export type KnockoutRound = "R32" | "R16" | "QF" | "SF" | "FINAL" | "CHAMPION";

// Vikter enligt PDF:en.
export const KNOCKOUT_WEIGHTS: Record<KnockoutRound, number> = {
  R32: 2, // sextondelsfinal
  R16: 2, // åttondelsfinal
  QF: 2, // kvartsfinal
  SF: 4, // semifinal
  FINAL: 6, // final
  CHAMPION: 10, // världsmästare
};

export const BONUS_WEIGHTS = {
  topScorer: 8, // rätt skyttekung
  topScorerGoals: 5, // rätt antal mål för skyttekungen – OBEROENDE av rätt spelare (PDF)
};

export interface KnockoutPrediction {
  teamsByRound: Record<KnockoutRound, string[]>;
  champion: string;
  topScorer: string;
  topScorerGoals: number;
  totalGoals: number; // endast utslagsfråga – ger inga poäng
}

export interface KnockoutActual {
  teamsByRound: Partial<Record<KnockoutRound, Set<string>>>;
  champion?: string;
  topScorer?: string;
  topScorerGoals?: number;
}

/** Slutspels- + bonuspoäng för en spelare. Totalt antal mål ger inga poäng (utslagsfråga). */
export function scoreKnockout(
  pred: KnockoutPrediction,
  actual: KnockoutActual,
  weights: Record<KnockoutRound, number> = KNOCKOUT_WEIGHTS,
  bonus = BONUS_WEIGHTS,
): number {
  let pts = 0;

  for (const round of Object.keys(weights) as KnockoutRound[]) {
    const reached = actual.teamsByRound[round];
    if (!reached || round === "CHAMPION") continue;
    for (const team of pred.teamsByRound[round] ?? []) {
      if (reached.has(team)) pts += weights[round];
    }
  }

  if (actual.champion && pred.champion === actual.champion) pts += weights.CHAMPION;
  // Skyttekung: Excel har fulla namn, API förkortar ("L. Messi") – matcha tolerant.
  if (actual.topScorer && pred.topScorer && samePlayer(pred.topScorer, actual.topScorer)) {
    pts += bonus.topScorer;
  }
  // Antal mål bedöms separat – rätt siffra ger poäng även med fel skyttekung.
  if (actual.topScorerGoals != null && pred.topScorerGoals === actual.topScorerGoals) {
    pts += bonus.topScorerGoals;
  }

  return pts;
}
