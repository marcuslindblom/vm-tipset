// Skriver ut importerade grupptips för granskning (ögna mot Excel).
//
//   npm run tips           # alla spelare
//   npm run tips -- Marcus # en spelare

import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync("src/data/predictions.json", "utf8"));
const who = process.argv[2];

const byGroup: Record<string, [string, any][]> = {};
for (const [key, f] of Object.entries<any>(data.fixtures)) {
  (byGroup[f.group] ??= []).push([key, f]);
}
for (const grp of Object.keys(byGroup)) {
  byGroup[grp].sort((a, b) => (a[1].kickoff ?? "").localeCompare(b[1].kickoff ?? ""));
}

const players: string[] = who ? [who] : data.players;
for (const player of players) {
  console.log(`\n=== ${player} ===`);
  for (const grp of Object.keys(byGroup).sort()) {
    const cells = byGroup[grp].map(([key, f]) => {
      const p = data.groupPredictions[key]?.[player];
      const score = p ? `${p[0]}-${p[1]}` : "??";
      return `${f.homeSv} ${score} ${f.awaySv}`;
    });
    console.log(`  Grupp ${grp}:  ` + cells.join("   ·   "));
  }
}
