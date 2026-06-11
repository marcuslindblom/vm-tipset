// Kontrollerar att varje xlsx i data/ följer samma mall innan import.
//
//   npm run validate
//
// Verifierar: rätt blad, 72 ifyllda gruppmatcher, slutspelsstruktur (32/16/8/4/2),
// bonusfält (mästare, skyttekung + mål, totalt antal mål) och inga omappade lagnamn.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readWorkbook } from "./lib-xlsx.ts";
import { parseGroup, parseKnockout, playerName } from "./parse-tips.ts";

const DATA_DIR = "data";
const EXPECT = { group: 72, R32: 32, R16: 16, QF: 8, SF: 4, FINAL: 2 } as const;

// Excel-felvärden (trasiga formler) – ska aldrig importeras.
const ERR = /^#(REF!|N\/A|VALUE!|DIV\/0!|NAME\?|NULL!|NUM!|SPILL!|CALC!|GETTING_DATA)/;
function errorCells(grid: Map<string, string> | undefined): string[] {
  if (!grid) return [];
  const out: string[] = [];
  for (const [ref, v] of grid) if (ERR.test(v)) out.push(`${ref}=${v}`);
  return out;
}

const files = readdirSync(DATA_DIR).filter((f) => /\.xlsx$/i.test(f) && !f.startsWith("~$"));
if (files.length === 0) {
  console.error(`Inga .xlsx i ${DATA_DIR}/`);
  process.exit(1);
}

console.log(`Validerar ${files.length} fil(er) mot mallen…\n`);
let blockingFiles = 0;
let warningFiles = 0;

for (const file of files.sort()) {
  const player = playerName(file);
  const blocking: string[] = []; // gruppspel – live nu, måste vara rätt
  const warnings: string[] = []; // slutspel/bonus – avgörs först 28 juni
  const wb = readWorkbook(join(DATA_DIR, file));

  if (!wb["GRUPPSPEL"]) blocking.push("saknar blad GRUPPSPEL");
  if (!wb["SLUTSPEL"]) warnings.push("saknar blad SLUTSPEL");

  const groupSheet = wb["GRUPPSPEL"] ?? Object.values(wb)[0];
  const koSheet = wb["SLUTSPEL"] ?? Object.values(wb)[1];

  // Trasiga formler (felvärden): blockerande i gruppspelet, varning i slutspelet.
  const errG = errorCells(groupSheet);
  const errK = errorCells(koSheet);
  if (errG.length) blocking.push(`Excel-felvärden i GRUPPSPEL: ${errG.slice(0, 5).join(", ")}${errG.length > 5 ? " …" : ""}`);
  if (errK.length) warnings.push(`Excel-felvärden i SLUTSPEL: ${errK.slice(0, 5).join(", ")}${errK.length > 5 ? " …" : ""}`);

  const unmapped = new Set<string>();
  const g = groupSheet ? parseGroup(groupSheet, unmapped) : [];
  if (g.length !== EXPECT.group) blocking.push(`${g.length}/${EXPECT.group} gruppmatcher ifyllda`);
  if (unmapped.size) blocking.push(`omappade lagnamn (lägg till i src/teams.ts): ${[...unmapped].join(", ")}`);

  let ko: ReturnType<typeof parseKnockout> | null = null;
  if (koSheet) {
    ko = parseKnockout(koSheet);
    const roundCounts = (["R32", "R16", "QF", "SF", "FINAL"] as const)
      .filter((r) => ko!.teamsByRound[r].length !== EXPECT[r])
      .map((r) => `${r} ${ko!.teamsByRound[r].length}/${EXPECT[r]}`);
    if (ko.teamsByRound.R32.length === 0) {
      warnings.push("slutspelet ifyllt med RESULTAT i stället för lag (arket: 'Här tippas inga resultat')");
    } else if (roundCounts.length) {
      warnings.push(`slutspelsronder ofullständiga: ${roundCounts.join(", ")}`);
    }
    const missing = [
      !ko.champion && "världsmästare",
      !ko.topScorer && "skyttekung",
      !ko.topScorerGoals && "skyttekungens mål",
      !ko.totalGoals && "totalt antal mål",
    ].filter(Boolean);
    if (missing.length) warnings.push(`saknar bonussvar: ${missing.join(", ")}`);
  }

  if (blocking.length) {
    blockingFiles++;
    console.log(`✗ ${player}  (BLOCKERAR import)`);
    for (const i of blocking) console.log(`     ✗ ${i}`);
    for (const w of warnings) console.log(`     ⚠ ${w}`);
  } else if (warnings.length) {
    warningFiles++;
    console.log(`⚠ ${player.padEnd(10)} gruppspel OK (72) – men:`);
    for (const w of warnings) console.log(`     ⚠ ${w}`);
  } else {
    console.log(
      `✓ ${player.padEnd(10)} 72 matcher · slutspel komplett · mästare ${ko!.champion}, ` +
        `skyttekung ${ko!.topScorer} (${ko!.topScorerGoals} mål), totalt ${ko!.totalGoals}`,
    );
  }
}

console.log();
if (blockingFiles) {
  console.error(`✗ ${blockingFiles} fil(er) har BLOCKERANDE gruppspelsfel – fixa innan import.`);
  process.exit(1);
}
if (warningFiles) {
  console.log(
    `Alla filers gruppspel är OK (importeras). ${warningFiles} fil(er) har slutspels-/bonusvarningar ` +
      `(kan fixas före 28 juni).`,
  );
} else {
  console.log(`Alla ${files.length} filer följer mallen fullt ut. ✓`);
}
