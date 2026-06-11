// Slack Block Kit-meddelanden: händelsenotis + Arnes referat + topplista med pilar.
// Utan SLACK_WEBHOOK_URL körs allt i dry-run (loggar payloaden i stället för att posta).

import type { Env, Score } from "./types";
import type { StandingRow } from "./scoring";
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
    case "goal":
      return `⚽ MÅL! ${scoreLine(g)}${min}${g.scorer ? ` – ${g.scorer}${goalSuffix(g.detail)}` : ""}`;
    case "disallowed":
      return `🚫 Mål underkänt – ${scoreLine(g)}`;
    case "halftime":
      return `⏸️ Halvtid: ${scoreLine(g)}`;
    case "fulltime":
      return `✅ Slutresultat: ${scoreLine(g)}`;
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

export function buildGoalMessage(g: GoalView, standings: StandingRow[]): SlackMessage {
  const title = headline(g);
  const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: `*${title}*` } }];

  if (g.commentary) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `> _${g.commentary}_\n> — Arne` },
    });
  }

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: "🏆 *Ställning*\n```\n" + standingsText(standings) + "\n```" },
  });

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
