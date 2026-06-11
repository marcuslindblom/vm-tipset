// Skickar EN tydligt märkt testpost till Slack via webhooken i .dev.vars,
// med de riktiga Block Kit-byggarna så vi ser exakt hur en målnotis ser ut.
//
//   npx tsx scripts/post-test.ts

import { readFileSync } from "node:fs";
import { buildGoalMessage } from "../src/slack.ts";
import type { StandingRow } from "../src/scoring.ts";

function webhookUrl(): string {
  if (process.env.SLACK_WEBHOOK_URL) return process.env.SLACK_WEBHOOK_URL;
  const m = /^SLACK_WEBHOOK_URL=(.+)$/m.exec(readFileSync(".dev.vars", "utf8"));
  if (!m) throw new Error("SLACK_WEBHOOK_URL saknas (miljö eller .dev.vars)");
  return m[1].trim();
}

// Exempel-ställning (samma siffror som E2E-simuleringen).
const standings: StandingRow[] = [
  { player: "Marcus", points: 12, groupPoints: 12, bonusPoints: 0, exact: 2, rank: 1, prevRank: 2, delta: 1 },
  { player: "Erik", points: 7, groupPoints: 7, bonusPoints: 0, exact: 1, rank: 2, prevRank: 1, delta: -1 },
  { player: "Johan", points: 3, groupPoints: 3, bonusPoints: 0, exact: 0, rank: 3, prevRank: 3, delta: 0 },
  { player: "Anna", points: 0, groupPoints: 0, bonusPoints: 0, exact: 0, rank: 4, prevRank: 4, delta: 0 },
];

const msg = buildGoalMessage(
  {
    homeName: "Spanien",
    awayName: "Kap Verde",
    score: { home: 3, away: 0 },
    prevScore: { home: 2, away: 0 },
    minute: 78,
    finished: false,
    disallowed: false,
  },
  standings,
);

// Tydlig testbanner överst + i fallback-texten.
msg.blocks.unshift({
  type: "context",
  elements: [
    {
      type: "mrkdwn",
      text: "🧪 *Testpost från Arne* – så här ser en målnotis ut. Skarp rättning startar vid avspark.",
    },
  ],
});
msg.text = "🧪 Testpost: " + msg.text;

const res = await fetch(webhookUrl(), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(msg),
});
console.log("Slack svarade:", res.status, await res.text());
