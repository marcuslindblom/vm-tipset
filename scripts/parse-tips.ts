// Delad parsning av en tips-xlsx (används av både import.ts och validate.ts).

import { basename } from "node:path";
import { findCell, valueRightOf, type Grid } from "./lib-xlsx.ts";
import { fromSwedish, teamMatchKey } from "../src/teams.ts";
import type { KnockoutRound } from "../src/scoring.ts";

export function intOrNull(s?: string): number | null {
  if (s == null) return null;
  const n = Number(String(s).trim());
  return Number.isInteger(n) ? n : null;
}

// Svenska månader -> nummer. Längre former först (juni före jun).
const MONTHS: Record<string, string> = {
  januari: "01", jan: "01", februari: "02", feb: "02", mars: "03", mar: "03",
  april: "04", apr: "04", maj: "05", juni: "06", jun: "06", juli: "07", jul: "07",
  augusti: "08", aug: "08", september: "09", sep: "09", oktober: "10", okt: "10",
  november: "11", nov: "11", december: "12", dec: "12",
};

// "11 juni 21:00 TV4" -> ISO UTC. Tiderna i arket är svensk lokaltid (CEST = +02:00 i jun–jul).
export function parseKickoff(s?: string): string | null {
  if (!s) return null;
  const m = /(\d{1,2})\s+(juni|jun|juli|jul|maj|januari|jan|februari|feb|mars|mar|april|apr|augusti|aug|september|sep|oktober|okt|november|nov|december|dec)\s+(\d{1,2}):(\d{2})/i.exec(
    s,
  );
  if (!m) return null;
  const mon = MONTHS[m[2].toLowerCase()];
  if (!mon) return null;
  const iso = `2026-${mon}-${m[1].padStart(2, "0")}T${m[3].padStart(2, "0")}:${m[4]}:00+02:00`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export function playerName(file: string): string {
  const base = basename(file).replace(/\.xlsx$/i, "");
  return (base.split(" - ").pop() || base).trim();
}

export interface GroupPred {
  key: string;
  home: string;
  away: string;
  homeSv: string;
  awaySv: string;
  group: string;
  excelDate: string;
  h: number;
  a: number;
}

/** Parsa gruppspelets tippade resultat. Okända lagnamn samlas i `unmapped`. */
export function parseGroup(grid: Grid, unmapped: Set<string>): GroupPred[] {
  const preds: GroupPred[] = [];
  let group = "";
  for (let r = 1; r <= 250; r++) {
    const a = grid.get(`A${r}`);
    if (a) {
      const gm = /^Grupp\s+([A-L])\b/i.exec(a);
      if (gm) group = gm[1].toUpperCase();
    }
    const bSv = grid.get(`B${r}`);
    const dSv = grid.get(`D${r}`);
    const h = intOrNull(grid.get(`E${r}`));
    const aw = intOrNull(grid.get(`G${r}`));
    if (!bSv || !dSv || h == null || aw == null) continue;
    const home = fromSwedish(bSv);
    const away = fromSwedish(dSv);
    if (!home || !away) {
      if (!home) unmapped.add(bSv);
      if (!away) unmapped.add(dSv);
      continue;
    }
    preds.push({
      key: teamMatchKey(home, away),
      home, away, homeSv: bSv, awaySv: dSv, group, excelDate: a ?? "", h, a: aw,
    });
  }
  return preds;
}

// "BRONZE" lagras inte – bara gräns så semifinalen inte sväljer bronsmatchens lag.
const KO_HEADERS: { re: RegExp; round: KnockoutRound | "BRONZE" }[] = [
  { re: /^Sextondelsfinal/i, round: "R32" },
  { re: /^Åttondelsfinal/i, round: "R16" },
  { re: /^Kvartsfinal/i, round: "QF" },
  { re: /^Semifinal/i, round: "SF" },
  { re: /^Bronsmatch/i, round: "BRONZE" },
  { re: /^Final$/i, round: "FINAL" },
];

export interface KnockoutParsed {
  teamsByRound: Record<KnockoutRound, string[]>;
  champion: string;
  topScorer: string;
  topScorerGoals: number;
  totalGoals: number;
}

export function parseKnockout(grid: Grid): KnockoutParsed {
  const headers: { row: number; round: KnockoutRound | "BRONZE" }[] = [];
  for (let r = 1; r <= 250; r++) {
    const a = grid.get(`A${r}`);
    if (!a) continue;
    for (const h of KO_HEADERS) if (h.re.test(a)) headers.push({ row: r, round: h.round });
  }
  headers.sort((x, y) => x.row - y.row);

  const teamsByRound = {
    R32: [] as string[], R16: [] as string[], QF: [] as string[],
    SF: [] as string[], FINAL: [] as string[], CHAMPION: [] as string[],
  };

  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].row + 1;
    const end = (headers[i + 1]?.row ?? start + 40) - 1;
    const round = headers[i].round;
    if (round === "BRONZE") continue;
    for (let r = start; r <= end; r++) {
      for (const col of ["H", "J"]) {
        const sv = grid.get(`${col}${r}`);
        if (!sv) continue;
        const team = fromSwedish(sv);
        if (team) teamsByRound[round].push(team);
      }
    }
  }

  // ^-förankring så instruktionstexten högst upp (som nämner samma ord) inte matchas.
  const championCell = findCell(grid, /^Världsmästare/i);
  const championSv = championCell ? valueRightOf(grid, championCell.ref) : undefined;
  const champion = championSv ? fromSwedish(championSv) ?? championSv : "";
  if (champion) teamsByRound.CHAMPION.push(champion);

  const scorerCell = findCell(grid, /^VM.s Skyttekung\b/i);
  const topScorer = scorerCell ? valueRightOf(grid, scorerCell.ref) ?? "" : "";
  const goalsCell = findCell(grid, /^VM.s skyttekung.*Antal mål/i);
  const topScorerGoals = goalsCell ? intOrNull(valueRightOf(grid, goalsCell.ref)) ?? 0 : 0;
  const totalCell = findCell(grid, /^Totalt antal mål/i);
  const totalGoals = totalCell ? intOrNull(valueRightOf(grid, totalCell.ref)) ?? 0 : 0;

  return { teamsByRound, champion, topScorer, topScorerGoals, totalGoals };
}
