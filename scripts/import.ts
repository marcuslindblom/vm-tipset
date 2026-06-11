// Importerar alla spelares xlsx i data/ till src/data/predictions.json.
//
//   tsx scripts/import.ts            # offline: nyckla matcher på lagpar (funkar utan Pro)
//   tsx scripts/import.ts --fixtures # hämtar 2026-fixtures och nycklar på fixtureId (kräver Pro)
//
// Gruppspel: tippat resultat per match. Slutspel/bonus: lagval per rond + VM-vinnare m.m.

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import {
  readWorkbook,
  findCell,
  valueRightOf,
  splitRef,
  numToCol,
  colToNum,
  type Grid,
} from "./lib-xlsx.ts";
import { fromSwedish, teamMatchKey, canonicalizeEnglish, normalize } from "../src/teams.ts";
import type { KnockoutRound } from "../src/scoring.ts";

const DATA_DIR = "data";
const OUT = "src/data/predictions.json";

const offline = !process.argv.includes("--fixtures");

function intOrNull(s?: string): number | null {
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
function parseKickoff(s?: string): string | null {
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

function playerName(file: string): string {
  const base = basename(file).replace(/\.xlsx$/i, "");
  return (base.split(" - ").pop() || base).trim();
}

interface GroupPred {
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

const unmapped = new Set<string>();

function parseGroup(grid: Grid): GroupPred[] {
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
      home,
      away,
      homeSv: bSv,
      awaySv: dSv,
      group,
      excelDate: a ?? "",
      h,
      a: aw,
    });
  }
  return preds;
}

// "BRONZE" lagras inte – den finns bara med som gräns så semifinalen inte
// råkar svälja bronsmatchens lag (den ligger mellan semi och final i arket).
const KO_HEADERS: { re: RegExp; round: KnockoutRound | "BRONZE" }[] = [
  { re: /^Sextondelsfinal/i, round: "R32" },
  { re: /^Åttondelsfinal/i, round: "R16" },
  { re: /^Kvartsfinal/i, round: "QF" },
  { re: /^Semifinal/i, round: "SF" },
  { re: /^Bronsmatch/i, round: "BRONZE" },
  { re: /^Final$/i, round: "FINAL" },
];

function parseKnockout(grid: Grid) {
  // Hitta sektionernas startrader i kolumn A.
  const headers: { row: number; round: KnockoutRound | "BRONZE" }[] = [];
  for (let r = 1; r <= 250; r++) {
    const a = grid.get(`A${r}`);
    if (!a) continue;
    for (const h of KO_HEADERS) if (h.re.test(a)) headers.push({ row: r, round: h.round });
  }
  headers.sort((x, y) => x.row - y.row);

  const teamsByRound = {
    R32: [] as string[],
    R16: [] as string[],
    QF: [] as string[],
    SF: [] as string[],
    FINAL: [] as string[],
    CHAMPION: [] as string[],
  };

  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].row + 1;
    const end = (headers[i + 1]?.row ?? start + 40) - 1;
    const round = headers[i].round;
    if (round === "BRONZE") continue; // bara gräns, lagras inte
    for (let r = start; r <= end; r++) {
      for (const col of ["H", "J"]) {
        const sv = grid.get(`${col}${r}`);
        if (!sv) continue;
        const team = fromSwedish(sv);
        if (team) teamsByRound[round].push(team);
      }
    }
  }

  // VM-vinnare, skyttekung, antal mål, totalt antal mål.
  // Regex förankras med ^ så instruktionstexten högst upp (som nämner samma ord) inte matchas.
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

// ── Valfri fixture-hämtning (kräver Pro / 2026-åtkomst) ───────────────────────
async function fetchFixtures(): Promise<Map<string, { id: number; date: string; round: string }>> {
  const env = readDevVars();
  const host = process.env.APISPORTS_HOST || "https://v3.football.api-sports.io";
  const key = process.env.APISPORTS_KEY || env.APISPORTS_KEY;
  if (!key) throw new Error("APISPORTS_KEY saknas (sätt i miljön eller .dev.vars)");
  const url = `${host}/fixtures?league=1&season=2026`;
  const res = await fetch(url, { headers: apiHeaders(host, key) });
  const json: any = await res.json();
  if (json.errors && Object.keys(json.errors).length) {
    throw new Error("API-Football: " + JSON.stringify(json.errors));
  }
  const map = new Map<string, { id: number; date: string; round: string }>();
  for (const f of json.response as any[]) {
    const home = canonicalizeEnglish(f.teams.home.name);
    const away = canonicalizeEnglish(f.teams.away.name);
    map.set(teamMatchKey(home, away), {
      id: f.fixture.id,
      date: f.fixture.date,
      round: f.league.round,
    });
  }
  return map;
}

function apiHeaders(host: string, key: string): Record<string, string> {
  return host.includes("rapidapi")
    ? { "x-rapidapi-key": key, "x-rapidapi-host": new URL(host).host }
    : { "x-apisports-key": key };
}

function readDevVars(): Record<string, string> {
  try {
    const txt = readFileSync(".dev.vars", "utf8");
    const out: Record<string, string> = {};
    for (const line of txt.split("\n")) {
      const m = /^\s*([A-Z_]+)\s*=\s*(.+)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].trim();
    }
    return out;
  } catch {
    return {};
  }
}

// ── Kör ───────────────────────────────────────────────────────────────────────
async function main() {
  const files = readdirSync(DATA_DIR).filter((f) => /\.xlsx$/i.test(f) && !f.startsWith("~$"));
  if (files.length === 0) {
    console.error(`Inga .xlsx hittades i ${DATA_DIR}/`);
    process.exit(1);
  }

  let fixtureMap: Map<string, { id: number; date: string; round: string }> | null = null;
  if (!offline) {
    console.log("Hämtar VM 2026-fixtures från API-Football …");
    fixtureMap = await fetchFixtures();
    console.log(`  ${fixtureMap.size} fixtures hämtade.`);
  }

  const players: string[] = [];
  const fixtures: Record<string, any> = {};
  const groupPredictions: Record<string, Record<string, [number, number]>> = {};
  const knockout: Record<string, any> = {};
  const kickoffSet = new Set<string>(); // alla avsparkstider (grupp + slutspel) för schemastyrning
  let matchedToFixtureId = 0;
  let missingFixtureId = 0;

  for (const file of files) {
    const player = playerName(file);
    players.push(player);
    const wb = readWorkbook(join(DATA_DIR, file));
    const groupSheet = wb["GRUPPSPEL"] ?? Object.values(wb)[0];
    const koSheet = wb["SLUTSPEL"] ?? Object.values(wb)[1];

    for (const g of parseGroup(groupSheet)) {
      let key = g.key;
      let fixtureId: number | null = null;
      let apiDate: string | null = null;
      if (fixtureMap) {
        const f = fixtureMap.get(g.key);
        if (f) {
          key = String(f.id);
          fixtureId = f.id;
          apiDate = f.date;
          matchedToFixtureId++;
        } else {
          missingFixtureId++;
          console.warn(`  ⚠ ingen fixture för ${g.home} – ${g.away} (${player})`);
        }
      }
      // I fixtures-läge: använd API:ts exakta avsparkstid; annars Excel-tiden.
      const kickoff = apiDate ? new Date(apiDate).toISOString() : parseKickoff(g.excelDate);
      if (kickoff) kickoffSet.add(kickoff);
      fixtures[key] ??= {
        home: g.home,
        away: g.away,
        homeSv: g.homeSv,
        awaySv: g.awaySv,
        group: g.group,
        excelDate: g.excelDate,
        kickoff,
        fixtureId,
      };
      (groupPredictions[key] ??= {})[player] = [g.h, g.a];
    }

    if (koSheet) {
      knockout[player] = parseKnockout(koSheet);
      // Slutspelets avsparkstider ligger i kolumn B – samla in dem för schemastyrningen.
      for (const [ref, val] of koSheet) {
        if (/^B\d+$/.test(ref)) {
          const k = parseKickoff(val);
          if (k) kickoffSet.add(k);
        }
      }
    }
  }

  const out = {
    generatedFrom: files,
    keyBy: fixtureMap ? "fixtureId" : "teams",
    leagueId: 1,
    season: 2026,
    players,
    kickoffs: [...kickoffSet].sort(),
    fixtures,
    groupPredictions,
    knockout,
  };

  mkdirSync("src/data", { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2));

  console.log(`\n✓ Skrev ${OUT}`);
  console.log(`  spelare:       ${players.join(", ")}`);
  console.log(`  gruppmatcher:  ${Object.keys(groupPredictions).length}`);
  console.log(`  avsparkstider: ${out.kickoffs.length} (${out.kickoffs[0]?.slice(0, 16)} … ${out.kickoffs.at(-1)?.slice(0, 16)})`);
  console.log(`  nyckling:      ${out.keyBy}`);
  if (fixtureMap) console.log(`  fixtureId-match: ${matchedToFixtureId} ok, ${missingFixtureId} saknas`);
  if (unmapped.size) {
    console.warn(`\n  ⚠ Omappade lagnamn (lägg till i src/teams.ts): ${[...unmapped].join(", ")}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
