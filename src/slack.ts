// Slack Block Kit-meddelanden: händelsenotis + Arnes referat + topplista med pilar.
// Utan SLACK_WEBHOOK_URL körs allt i dry-run (loggar payloaden i stället för att posta).

import type { Env, Score } from "./types";
import { MATCH_POINTS, type StandingRow } from "./scoring";
import type { ChangeKind } from "./engine";

export interface GoalView {
  kind: ChangeKind;
  homeName: string;
  awayName: string;
  score: Score;
  minute: number | null;
  scorer?: string;
  detail?: string; // "Penalty", "Own Goal", "Second Yellow card" …
  team?: string; // lag för kort/straff
  context?: string; // t.ex. "Grupp F · VM 2026" (visas som liten etikett)
  commentary?: string | null; // Arnes AI-referat (kan saknas)
}

function arrow(delta: number): string {
  if (delta > 0) return `▲${delta}`;
  if (delta < 0) return `▼${-delta}`;
  return "  ";
}

function rankLabel(rank: number): string {
  return ["🥇", "🥈", "🥉"][rank - 1] ?? `${rank}.`;
}

/** Topplistan som monospace-block så kolumnerna ligger rakt. */
export function standingsText(rows: StandingRow[]): string {
  if (rows.length === 0) return "(inga poäng än)";
  const nameWidth = Math.max(...rows.map((r) => r.player.length));
  return rows
    .map((r) => {
      const pos = rankLabel(r.rank).padEnd(3);
      const name = r.player.padEnd(nameWidth);
      const pts = String(r.points).padStart(3);
      return `${pos} ${name}  ${pts} p  ${arrow(r.delta)}`;
    })
    .join("\n");
}

function scoreLine(g: GoalView): string {
  return `${g.homeName} ${g.score.home}–${g.score.away} ${g.awayName}`;
}

function goalSuffix(detail?: string): string {
  if (!detail) return "";
  if (/penalty/i.test(detail)) return " (straff)";
  if (/own goal/i.test(detail)) return " (självmål)";
  return "";
}

export function headline(g: GoalView): string {
  const min = g.minute != null ? ` (${g.minute}')` : "";
  switch (g.kind) {
    case "kickoff":
      return `⚽ AVSPARK · ${g.homeName} – ${g.awayName}`;
    case "goal":
      return `⚽ MÅL! ${scoreLine(g)}${min}${g.scorer ? ` – ${g.scorer}${goalSuffix(g.detail)}` : ""}`;
    case "disallowed":
      return `🚫 Mål underkänt – ${scoreLine(g)}`;
    case "halftime":
      return `⏸️ HALVTID · ${scoreLine(g)}`;
    case "fulltime":
      return `✅ FULL TID · ${scoreLine(g)}`;
    case "redcard": {
      const kind = /second yellow/i.test(g.detail ?? "") ? "Andra gula → rött" : "Rött kort";
      return `🟥 ${kind} – ${g.scorer ?? ""}${g.team ? ` (${g.team})` : ""}${min} · ${scoreLine(g)}`;
    }
    case "penalty_missed":
      return `❌ Missad straff – ${g.scorer ?? ""}${min} · ${scoreLine(g)}`;
  }
}

export interface SlackMessage {
  text: string;
  blocks: unknown[];
}

export interface MatchPointRow {
  player: string;
  points: number;
}

/** "Den här matchen gav:" – spelare grupperade per poäng (4/2/0). */
export function matchPointsText(rows: MatchPointRow[]): string {
  const byPts = new Map<number, string[]>();
  for (const r of rows) {
    if (!byPts.has(r.points)) byPts.set(r.points, []);
    byPts.get(r.points)!.push(r.player);
  }
  return [...byPts.keys()]
    .sort((a, b) => b - a)
    .map((p) => {
      const players = byPts.get(p)!.sort((a, b) => a.localeCompare(b, "sv"));
      const head = (p > 0 ? `+${p}` : `${p}`).padStart(3);
      const label = p === MATCH_POINTS.exact ? "  (exakt)" : p === MATCH_POINTS.sign ? "  (rätt tecken)" : "";
      return `${head}  ${players.join(" · ")}${label}`;
    })
    .join("\n");
}

/**
 * Bygger Slack-meddelandet. Under matchen (mål, halvtid, kort osv): bara rubrik +
 * Arnes referat. Vid FULL TID: även "den här matchen gav" + totalställningen.
 */
export function buildGoalMessage(
  g: GoalView,
  opts: { standings?: StandingRow[]; matchPoints?: MatchPointRow[] } = {},
): SlackMessage {
  const title = headline(g);
  const blocks: unknown[] = [];

  // Liten etikett ovanför rubriken så man ser vilken match (viktigt vid samtidiga matcher).
  if (g.context) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: g.context }] });

  blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${title}*` } });

  if (g.commentary) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `> _${g.commentary}_\n> — Arne` } });
  }

  if (g.kind === "fulltime" && opts.standings) {
    if (opts.matchPoints?.length) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: "⚽ *Den här matchen gav:*\n```\n" + matchPointsText(opts.matchPoints) + "\n```" },
      });
    }
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "📊 *Totalställning i VM-tipset*\n```\n" + standingsText(opts.standings) + "\n```" },
    });
  }

  return { text: title, blocks };
}

/** Fristående topplista (t.ex. /standings-route eller manuell post). */
export function buildStandingsMessage(standings: StandingRow[], heading = "🏆 Ställning"): SlackMessage {
  return {
    text: heading,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${heading}*\n` + "```\n" + standingsText(standings) + "\n```" },
      },
    ],
  };
}

export async function postSlack(env: Env, msg: SlackMessage): Promise<{ posted: boolean }> {
  if (!env.SLACK_WEBHOOK_URL) {
    console.log("[slack dry-run]", msg.text);
    return { posted: false };
  }
  const res = await fetch(env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(msg),
  });
  if (!res.ok) console.error(`Slack POST misslyckades: HTTP ${res.status}`);
  return { posted: res.ok };
}
