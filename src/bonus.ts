// Bonuskanalen: härleder faktiska utfall (grupp-placeringar ur resultaten + slutspels-
// trädet ur API-matcherna) och summerar grupp-placerings- + slutspels- + bonuspoäng per
// spelare till den `extraPoints`-map som computeStandings adderar ovanpå gruppmatchpoängen.

import type { LiveMatch, Score } from "./types";
import { isFinal } from "./types";
import type { FixtureInfo } from "./predictions";
import {
  predictedGroupTable,
  scoreGroupPlacements,
  scoreKnockout,
  type KnockoutActual,
  type KnockoutPrediction,
  type KnockoutRound,
  type Prediction,
} from "./scoring";
import { canonicalizeEnglish } from "./teams";

// ── Slutspelsträd ur API-matcher ──────────────────────────────────────────────

// Tolerant mappning API-rondsträng → vår KnockoutRound (jfr Excel-parserns KO_HEADERS).
// Ordningen avgör: kvarts/semi/brons måste kollas före "final", eftersom de orden
// själva innehåller "final". Verifiera de exakta API-strängarna empiriskt vid behov.
const KO_ROUNDS: { re: RegExp; round: KnockoutRound | "BRONZE" }[] = [
  { re: /round of 32|1\/16|sextondel/i, round: "R32" },
  { re: /round of 16|1\/8|åttondel/i, round: "R16" },
  { re: /quarter|kvarts/i, round: "QF" },
  { re: /semi/i, round: "SF" },
  { re: /3rd place|third place|bronze|brons/i, round: "BRONZE" },
  { re: /final/i, round: "FINAL" },
];

export function matchRound(round: string): KnockoutRound | "BRONZE" | null {
  for (const r of KO_ROUNDS) if (r.re.test(round)) return r.round;
  return null;
}

/** Ser rondsträngen ut som ett slutspel men matchar ingen känd rond? (observability) */
export function looksUnmatchedKnockout(round: string): boolean {
  if (matchRound(round)) return false;
  return !/group|^$/i.test(round); // allt utom gruppspel/tomt som vi inte känner igen
}

/** Serialiserbar form (Set → array) av KnockoutActual för Durable-Object-storage. */
export interface StoredKnockoutActual {
  teamsByRound: Partial<Record<KnockoutRound, string[]>>;
  champion?: string;
  topScorer?: string;
  topScorerGoals?: number;
}

export const EMPTY_ACTUAL: StoredKnockoutActual = { teamsByRound: {} };

/**
 * Härled faktiskt slutspelsträd ur alla säsongens matcher. Att ha *spelat* en rond =
 * att ha *nått* den (exakt vad scoreKnockout belönar), så bägge lagen i varje
 * slutspelsmatch räknas oavsett matchstatus – så fort en rond är lottad får tipsen
 * poäng. Bronsmatchen exkluderas så dess lag inte räknas som finalister. Mästare =
 * finalvinnaren när finalen är slutspelad.
 */
export function deriveKnockoutActual(fixtures: LiveMatch[]): StoredKnockoutActual {
  const teamsByRound: Partial<Record<KnockoutRound, Set<string>>> = {};
  let champion: string | undefined;
  for (const fx of fixtures) {
    const round = matchRound(fx.round);
    if (!round || round === "BRONZE") continue;
    const set = (teamsByRound[round] ??= new Set<string>());
    set.add(canonicalizeEnglish(fx.home.name));
    set.add(canonicalizeEnglish(fx.away.name));
    if (round === "FINAL" && isFinal(fx.status) && fx.winner) champion = canonicalizeEnglish(fx.winner);
  }
  const out: StoredKnockoutActual = { teamsByRound: {} };
  for (const [round, set] of Object.entries(teamsByRound)) out.teamsByRound[round as KnockoutRound] = [...set!];
  if (champion) out.champion = champion;
  return out;
}

/** Stored-form (array) → KnockoutActual (Set) som scoreKnockout vill ha. */
export function toKnockoutActual(s: StoredKnockoutActual): KnockoutActual {
  const teamsByRound: Partial<Record<KnockoutRound, Set<string>>> = {};
  for (const [round, teams] of Object.entries(s.teamsByRound)) {
    if (teams) teamsByRound[round as KnockoutRound] = new Set(teams);
  }
  return { teamsByRound, champion: s.champion, topScorer: s.topScorer, topScorerGoals: s.topScorerGoals };
}

// ── Faktiska grupptabeller ur gruppresultaten ─────────────────────────────────

const scoreToPred = (s: Score): Prediction => ({ home: s.home, away: s.away });

/**
 * Faktisk etta/tvåa per grupp, härledd ur gruppresultaten. Bara grupper där samtliga
 * matcher spelats ger placeringspoäng. Tabellsorteringen återanvänder projektets egen
 * modell (poäng → målskillnad → gjorda mål) – en förenkling mot FIFA:s inbördes möten,
 * men samma modell som tipsen rättas mot.
 */
export function computeActualGroupTables(
  results: Map<string, Score>,
  fixtures: Record<string, FixtureInfo>,
): Map<string, { first: string; second: string }> {
  const byGroup = new Map<string, { teams: Set<string>; matches: { home: string; away: string; key: string }[] }>();
  for (const [key, f] of Object.entries(fixtures)) {
    if (!f.group) continue;
    const g = byGroup.get(f.group) ?? { teams: new Set<string>(), matches: [] };
    g.teams.add(f.home);
    g.teams.add(f.away);
    g.matches.push({ home: f.home, away: f.away, key });
    byGroup.set(f.group, g);
  }

  const out = new Map<string, { first: string; second: string }>();
  for (const [group, g] of byGroup) {
    if (!g.matches.every((m) => results.has(m.key))) continue; // bara färdigspelade grupper
    const table = predictedGroupTable(
      [...g.teams],
      g.matches.map((m) => ({ home: m.home, away: m.away, pred: scoreToPred(results.get(m.key)!) })),
    );
    if (table.length >= 2) out.set(group, { first: table[0].team, second: table[1].team });
  }
  return out;
}

// ── extraPoints: grupp-placering + slutspel + bonus per spelare ────────────────

/** En spelares förutsagda etta/tvåa per grupp, ur deras tippade gruppresultat. */
function predictedPlacements(
  player: string,
  groupPreds: Map<string, Map<string, Prediction>>,
  fixtures: Record<string, FixtureInfo>,
): { group: string; first: string; second: string }[] {
  const byGroup = new Map<string, { teams: Set<string>; matches: { home: string; away: string; pred: Prediction }[] }>();
  for (const [key, f] of Object.entries(fixtures)) {
    if (!f.group) continue;
    const pred = groupPreds.get(key)?.get(player);
    if (!pred) continue;
    const g = byGroup.get(f.group) ?? { teams: new Set<string>(), matches: [] };
    g.teams.add(f.home);
    g.teams.add(f.away);
    g.matches.push({ home: f.home, away: f.away, pred });
    byGroup.set(f.group, g);
  }
  const out: { group: string; first: string; second: string }[] = [];
  for (const [group, g] of byGroup) {
    const table = predictedGroupTable([...g.teams], g.matches);
    if (table.length >= 2) out.push({ group, first: table[0].team, second: table[1].team });
  }
  return out;
}

export interface ExtraPointsInput {
  players: string[];
  groupPreds: Map<string, Map<string, Prediction>>;
  fixtures: Record<string, FixtureInfo>;
  results: Map<string, Score>;
  knockoutPreds: Map<string, KnockoutPrediction>;
  knockoutActual: KnockoutActual;
}

/** Grupp-placering + slutspel + bonus per spelare → extraPoints för computeStandings. */
export function computeExtraPoints(input: ExtraPointsInput): Map<string, number> {
  const actualTables = computeActualGroupTables(input.results, input.fixtures);
  const out = new Map<string, number>();
  for (const player of input.players) {
    const placement = scoreGroupPlacements(predictedPlacements(player, input.groupPreds, input.fixtures), actualTables);
    const ko = input.knockoutPreds.get(player);
    const knockout = ko ? scoreKnockout(ko, input.knockoutActual) : 0;
    const total = placement + knockout;
    if (total) out.set(player, total);
  }
  return out;
}
