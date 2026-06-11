// Importerar alla spelares xlsx i data/ till src/data/predictions.json.
//
//   tsx scripts/import.ts            # offline: nyckla matcher på lagpar (funkar utan Pro)
//   tsx scripts/import.ts --fixtures # hämtar 2026-fixtures och nycklar på fixtureId (kräver Pro)
//
// Gruppspel: tippat resultat per match. Slutspel/bonus: lagval per rond + VM-vinnare m.m.

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readWorkbook } from "./lib-xlsx.ts";
import { teamMatchKey, canonicalizeEnglish } from "../src/teams.ts";
import { parseGroup, parseKnockout, parseKickoff, playerName } from "./parse-tips.ts";

const DATA_DIR = "data";
const OUT = "src/data/predictions.json";

const offline = !process.argv.includes("--fixtures");

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
  const unmapped = new Set<string>();
  let matchedToFixtureId = 0;
  let missingFixtureId = 0;

  for (const file of files) {
    const player = playerName(file);
    players.push(player);
    const wb = readWorkbook(join(DATA_DIR, file));
    const groupSheet = wb["GRUPPSPEL"] ?? Object.values(wb)[0];
    const koSheet = wb["SLUTSPEL"] ?? Object.values(wb)[1];

    for (const g of parseGroup(groupSheet, unmapped)) {
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
