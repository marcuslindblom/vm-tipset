// Bonuskanalen: härleder faktiska utfall (grupp-placeringar ur resultaten + slutspels-
// trädet ur API-matcherna) och summerar grupp-placerings- + slutspels- + bonuspoäng per
// spelare till den `extraPoints`-map som computeStandings adderar ovanpå gruppmatchpoängen.

import type { LiveMatch, Score } from "./types";
import { isFinal, isLive } from "./types";
import type { FixtureInfo } from "./predictions";
import {
  predictedGroupTable,
  scoreGroupPlacements,
  scoreKnockout,
  KNOCKOUT_WEIGHTS,
  type KnockoutActual,
  type KnockoutPrediction,
  type KnockoutRound,
  type Prediction,
} from "./scoring";
import { canonicalizeEnglish, toSwedish } from "./teams";

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

// Ett lag når nästa rond genom att VINNA sin match i nuvarande rond.
const NEXT_ROUND: Partial<Record<KnockoutRound, KnockoutRound>> = {
  R32: "R16",
  R16: "QF",
  QF: "SF",
  SF: "FINAL",
};

/**
 * Vinnaren i en avgjord match. Föredrar API:ts winner-flagga (hanterar straffar), men
 * faller tillbaka på ett avgörande resultat om flaggan släpar i feeden – så poängen inte
 * väntar en pollcykel på att winner-fältet ska dyka upp. Oavgjort utan flagga → null.
 */
export function winnerOf(m: { winner?: string | null; score: Score; home: { name: string }; away: { name: string } }): string | null {
  if (m.winner) return m.winner;
  if (m.score.home > m.score.away) return m.home.name;
  if (m.score.away > m.score.home) return m.away.name;
  return null;
}

/**
 * Härled faktiskt slutspelsträd ur alla säsongens matcher.
 *
 * R32 = de 32 lag som tog sig dit (spelar en R32-match). Övriga ronder härleds ur
 * VINNARNA: att nå R16 = vinna sin R32-match, osv. Det ger per-match-timing – poängen
 * landar exakt när matchen avgörs – och undviker buggen där ett lag som vunnit men vars
 * nästa match ännu inte lottats tyst missar sin rond. Bronsmatchen exkluderas. Mästare =
 * finalvinnaren.
 */
export function deriveKnockoutActual(fixtures: LiveMatch[]): StoredKnockoutActual {
  const teamsByRound: Partial<Record<KnockoutRound, Set<string>>> = {};
  let champion: string | undefined;
  for (const fx of fixtures) {
    const round = matchRound(fx.round);
    if (!round || round === "BRONZE") continue;
    // Bas: lagen som spelar sextondelsfinal har nått R32.
    if (round === "R32") {
      const set = (teamsByRound.R32 ??= new Set<string>());
      set.add(canonicalizeEnglish(fx.home.name));
      set.add(canonicalizeEnglish(fx.away.name));
    }
    // Vinnaren går vidare till nästa rond (final-vinnaren blir mästare).
    const winner = isFinal(fx.status) ? winnerOf(fx) : null;
    if (winner) {
      const w = canonicalizeEnglish(winner);
      if (round === "FINAL") champion = w;
      else {
        const next = NEXT_ROUND[round];
        if (next) (teamsByRound[next] ??= new Set<string>()).add(w);
      }
    }
  }
  const out: StoredKnockoutActual = { teamsByRound: {} };
  for (const [round, set] of Object.entries(teamsByRound)) out.teamsByRound[round as KnockoutRound] = [...set!];
  if (champion) out.champion = champion;
  return out;
}

// ── Slutspelsmatchens insats (för live-presentationen) ────────────────────────

/** Målet "CHAMPION" = att vinna finalen (10 p); annars nästa rond. */
export type ReachTarget = KnockoutRound | "CHAMPION";

/** Vad matchens vinnare når + poängen för det. null för bronsmatch/gruppspel. */
export function knockoutAdvance(roundStr: string): { target: ReachTarget; weight: number } | null {
  const round = matchRound(roundStr);
  if (!round || round === "BRONZE") return null;
  if (round === "FINAL") return { target: "CHAMPION", weight: KNOCKOUT_WEIGHTS.CHAMPION };
  const target = NEXT_ROUND[round];
  return target ? { target, weight: KNOCKOUT_WEIGHTS[target] } : null;
}

/** Spelare som tippat `team` att nå `target` (rond eller VM-guld). */
export function playersReaching(
  team: string,
  target: ReachTarget,
  knockoutPreds: Map<string, KnockoutPrediction>,
): string[] {
  const canon = canonicalizeEnglish(team);
  const out: string[] = [];
  for (const [player, k] of knockoutPreds) {
    const picks = target === "CHAMPION" ? [k.champion] : k.teamsByRound[target] ?? [];
    if (picks.some((t) => canonicalizeEnglish(t) === canon)) out.push(player);
  }
  return out;
}

// Svensk benämning på ronden ett lag når genom att vinna sin match.
const REACH_LABEL: Record<ReachTarget, string> = {
  R32: "sextondelsfinalen",
  R16: "åttondelsfinalen",
  QF: "kvartsfinalen",
  SF: "semifinalen",
  FINAL: "finalen",
  CHAMPION: "VM-guld",
};

export interface KnockoutCard {
  koTips?: string; // avspark: vem tippade lagen vidare
  koResult?: string; // full tid: vilket lag gick vidare + vilka som får rundpoängen
}

// Matchens EGEN rond i obestämd form ("sextondelsfinal") – skilt från REACH_LABEL
// som är ronden man NÅR genom att vinna (bestämd form, "åttondelsfinalen").
export function roundNameSv(roundStr: string): string {
  switch (matchRound(roundStr)) {
    case "R32": return "sextondelsfinal";
    case "R16": return "åttondelsfinal";
    case "QF": return "kvartsfinal";
    case "SF": return "semifinal";
    case "FINAL": return "final";
    case "BRONZE": return "bronsmatch";
    default: return "";
  }
}

/** Slutspelsmatch i schemat (lagras för att @arne ska kunna svara på "nästa match"). */
export interface KoFixture {
  round: string;
  home: string;
  away: string;
  kickoff: string; // ISO
  status: string;
}

/**
 * Bygg schematexten för slutspelet (ren funktion): PÅGÅR-rader för live-matcher och en
 * NÄSTA-rad för närmaste kommande match. Speglar gruppspelets radform (utan resultattips,
 * som inte finns i slutspelet). Placeholder-lag (tomma namn) filtreras bort. null = inget.
 */
export function knockoutScheduleText(koFixtures: KoFixture[], nowMs: number): string | null {
  const real = koFixtures.filter((f) => f.home && f.away);
  const lines: string[] = [];
  for (const f of real.filter((f) => isLive(f.status))) {
    lines.push(`PÅGÅR: ${toSwedish(f.home)}–${toSwedish(f.away)} (${roundNameSv(f.round)})`);
  }
  const next = real
    .filter((f) => !isFinal(f.status) && !isLive(f.status) && Date.parse(f.kickoff) > nowMs)
    .sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff))[0];
  if (next) {
    const when = new Date(next.kickoff).toISOString().slice(0, 16).replace("T", " ");
    lines.push(`NÄSTA: ${toSwedish(next.home)}–${toSwedish(next.away)} (${roundNameSv(next.round)}, avspark ${when} UTC)`);
  }
  return lines.length ? lines.join("\n") : null;
}

/**
 * Bygg slutspelskortet för en match (ren funktion – testbar). En knockout-match saknar
 * resultattips, så vid avspark visas vem som tippat lagen vidare och vid full tid vilket
 * lag som gick vidare + vilka som får rundpoängen. Tomt för bronsmatch/okänd rond.
 */
export function knockoutCardText(args: {
  kind: string;
  roundStr: string;
  homeEn: string;
  awayEn: string;
  score: Score;
  winner: string | null;
  knockoutPreds: Map<string, KnockoutPrediction>;
}): KnockoutCard {
  const adv = knockoutAdvance(args.roundStr);
  if (!adv) return {};
  const label = REACH_LABEL[adv.target];

  if (args.kind === "kickoff") {
    const row = (en: string) => {
      const who = playersReaching(en, adv.target, args.knockoutPreds);
      return `  *${toSwedish(en)}* → ${who.length ? who.join(", ") : "ingen"}`;
    };
    return {
      koTips: `🎯 *Vidare till ${label} (${adv.weight} p) tippade:*\n${row(args.homeEn)}\n${row(args.awayEn)}`,
    };
  }
  if (args.kind === "fulltime") {
    const winner = winnerOf({ winner: args.winner, score: args.score, home: { name: args.homeEn }, away: { name: args.awayEn } });
    if (!winner) return {};
    const who = playersReaching(winner, adv.target, args.knockoutPreds);
    const verb = adv.target === "CHAMPION" ? "är världsmästare" : `vidare till ${label}`;
    return {
      koResult: `🏆 *${toSwedish(winner)} ${verb}* → +${adv.weight} p: ${who.length ? who.join(", ") : "ingen tippade det"}`,
    };
  }
  return {};
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
