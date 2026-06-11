// Rättningsmotorn – rena funktioner, helt utan I/O så de är enkla att enhetstesta.
//
// Gruppspel: tippat resultat per match rättas live med stegen 5 / 3 / 2.
// Slutspel + bonus: poäng per korrekt lag som når en rond, samt VM-vinnare/skyttekung/
// totalt antal mål. Slutspelet avgörs vid matchslut, inte per mål.

import type { Score } from "./types";

export interface Prediction {
  home: number;
  away: number;
}

// ── Gruppspel: poäng för en enskild match ────────────────────────────────────
//   5 = exakt resultat
//   3 = rätt målskillnad (inkluderar oavgjort med annan siffra, t.ex. 1-1 vs 2-2)
//   2 = rätt utfall (1X2) men fel målskillnad
//   0 = fel
export const MATCH_POINTS = { exact: 5, goalDiff: 3, outcome: 2 } as const;

export function gradeMatch(pred: Prediction, actual: Score): number {
  if (pred.home === actual.home && pred.away === actual.away) return MATCH_POINTS.exact;
  if (pred.home - pred.away === actual.home - actual.away) return MATCH_POINTS.goalDiff;
  if (Math.sign(pred.home - pred.away) === Math.sign(actual.home - actual.away)) {
    return MATCH_POINTS.outcome;
  }
  return 0;
}

// ── Ställning ─────────────────────────────────────────────────────────────────

export interface StandingRow {
  player: string;
  points: number; // totalt
  groupPoints: number;
  bonusPoints: number; // slutspel + bonus
  exact: number; // antal exakta resultat (tiebreak + kul att visa)
  rank: number;
  prevRank: number | null;
  delta: number; // prevRank - rank  (>0 = klättrat, <0 = tappat)
}

/** Gruppspelspoäng per spelare för alla matcher som har ett (live eller slutgiltigt) resultat. */
export function computeGroupPoints(
  predictionsByMatch: Map<string, Map<string, Prediction>>,
  results: Map<string, Score>,
): Map<string, { points: number; exact: number }> {
  const out = new Map<string, { points: number; exact: number }>();
  for (const [key, score] of results) {
    const preds = predictionsByMatch.get(key);
    if (!preds) continue;
    for (const [player, pred] of preds) {
      const pts = gradeMatch(pred, score);
      const cur = out.get(player) ?? { points: 0, exact: 0 };
      cur.points += pts;
      if (pts === MATCH_POINTS.exact) cur.exact += 1;
      out.set(player, cur);
    }
  }
  return out;
}

/**
 * Räknar ut hela ställningen, sorterad och rankad.
 * `extraPoints` = slutspels- + bonuspoäng (0 tills slutspelet avgörs).
 * `prevRanking` = senast postade placering per spelare, för upp/ned-pilar.
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

  rows.sort(
    (a, b) =>
      b.points - a.points || b.exact - a.exact || a.player.localeCompare(b.player, "sv"),
  );

  // Delad placering vid lika (1, 2, 2, 4 …).
  for (let i = 0; i < rows.length; i++) {
    const prev = rows[i - 1];
    if (i > 0 && rows[i].points === prev.points && rows[i].exact === prev.exact) {
      rows[i].rank = prev.rank;
    } else {
      rows[i].rank = i + 1;
    }
  }
  for (const r of rows) r.delta = r.prevRank == null ? 0 : r.prevRank - r.rank;

  return rows;
}

export function rankingMap(rows: StandingRow[]): Map<string, number> {
  return new Map(rows.map((r) => [r.player, r.rank]));
}

// ── Slutspel + bonus ──────────────────────────────────────────────────────────
// OBS: poängvikterna nedan är DEFAULTS och bör bekräftas mot gruppens egna regler.
// (Excel-arket anger inte poängvärdena – bara att poäng ges per lag som når en rond.)

export type KnockoutRound = "R32" | "R16" | "QF" | "SF" | "FINAL" | "CHAMPION";

export const KNOCKOUT_WEIGHTS: Record<KnockoutRound, number> = {
  R32: 1, // sextondelsfinal
  R16: 2, // åttondelsfinal
  QF: 4, // kvartsfinal
  SF: 6, // semifinal
  FINAL: 8, // final
  CHAMPION: 12, // världsmästare
};

export const BONUS_WEIGHTS = {
  topScorer: 8, // rätt skyttekung
  topScorerGoals: 4, // rätt antal mål för skyttekungen
  totalGoals: 5, // rätt totalt antal mål (utslagsfrågan)
};

export interface KnockoutPrediction {
  teamsByRound: Record<KnockoutRound, string[]>; // kanoniska lagnamn per rond
  champion: string;
  topScorer: string;
  topScorerGoals: number;
  totalGoals: number;
}

export interface KnockoutActual {
  teamsByRound: Partial<Record<KnockoutRound, Set<string>>>;
  champion?: string;
  topScorer?: string;
  topScorerGoals?: number;
  totalGoals?: number;
}

/** Slutspels- + bonuspoäng för en spelare. Endast ronder som faktiskt avgjorts räknas. */
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
  if (actual.topScorer && pred.topScorer === actual.topScorer) {
    pts += bonus.topScorer;
    if (actual.topScorerGoals != null && pred.topScorerGoals === actual.topScorerGoals) {
      pts += bonus.topScorerGoals;
    }
  }
  if (actual.totalGoals != null && pred.totalGoals === actual.totalGoals) {
    pts += bonus.totalGoals;
  }

  return pts;
}
