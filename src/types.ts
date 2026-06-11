// Delade typer för hela tjänsten.

export interface Env {
  WATCHER: DurableObjectNamespace;
  APISPORTS_KEY: string;
  APISPORTS_HOST: string;
  SLACK_WEBHOOK_URL?: string;
  WC_LEAGUE_ID: string;
  SEASON: string;
  POLL_SECONDS: string; // intervall mellan pollningar UNDER ett matchfönster
  MATCH_WINDOW_MINUTES: string; // hur länge efter avspark en match anses pågå
  KICKOFF_LEAD_SECONDS: string; // hur långt före avspark loopen vaknar
  IDLE_MAX_SLEEP_SECONDS: string; // max sovtid mellan matcher (schemakoll, inget API-anrop)
}

export interface Score {
  home: number;
  away: number;
}

/** En match som den ser ut just nu (från API-Football live=all eller fixtures). */
export interface LiveMatch {
  fixtureId: number;
  leagueId: number;
  round: string;
  date: string;
  home: { id: number; name: string };
  away: { id: number; name: string };
  score: Score;
  status: string; // kort statuskod: NS, 1H, HT, 2H, ET, P, FT, AET, PEN, PST...
  elapsed: number | null;
}

/** Lagrat resultat per match i Durable Object-storage. */
export interface MatchResult {
  fixtureId: number;
  home: string;
  away: string;
  score: Score;
  status: string;
  final: boolean;
}

export const FINAL_STATUSES = new Set(["FT", "AET", "PEN", "WO", "AWD"]);
export const LIVE_STATUSES = new Set(["1H", "HT", "2H", "ET", "BT", "P", "INT", "LIVE"]);

export function isFinal(status: string): boolean {
  return FINAL_STATUSES.has(status);
}
export function isLive(status: string): boolean {
  return LIVE_STATUSES.has(status);
}
