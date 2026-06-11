// Slack Block Kit-meddelanden: målnotis + snygg topplista med upp/ned-pilar.
// Utan SLACK_WEBHOOK_URL körs allt i dry-run (loggar payloaden i stället för att posta).

import type { Env, Score } from "./types";
import type { StandingRow } from "./scoring";

export interface GoalView {
  homeName: string; // visningsnamn (svenska)
  awayName: string;
  score: Score;
  prevScore?: Score;
  minute: number | null;
  finished: boolean;
  disallowed: boolean; // ställningen gick ned (VAR)
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

function headline(g: GoalView): string {
  const s = `${g.homeName} ${g.score.home}–${g.score.away} ${g.awayName}`;
  if (g.disallowed) return `🚫 Mål underkänt – ${s}`;
  if (g.finished) return `✅ Slutresultat: ${s}`;
  const min = g.minute != null ? ` (${g.minute}')` : "";
  return `⚽ MÅL! ${s}${min}`;
}

export interface SlackMessage {
  text: string; // fallback-text för notiser
  blocks: unknown[];
}

export function buildGoalMessage(g: GoalView, standings: StandingRow[]): SlackMessage {
  const title = headline(g);
  return {
    text: title,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${title}*` } },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "🏆 *Ställning (live)*\n```\n" + standingsText(standings) + "\n```",
        },
      },
    ],
  };
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
