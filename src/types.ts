// Delade typer för hela tjänsten.

export interface Env {
  WATCHER: DurableObjectNamespace;
  APISPORTS_KEY: string;
  APISPORTS_HOST: string;
  SLACK_WEBHOOK_URL?: string;
  SLACK_SIGNING_SECRET?: string; // verifierar inkommande Slack-requests (@arne)
  SLACK_BOT_TOKEN?: string; // xoxb-… för privata svar (chat.postEphemeral)
  WC_LEAGUE_ID: string;
  SEASON: string;
  POLL_SECONDS: string; // intervall mellan pollningar UNDER ett matchfönster
  MATCH_WINDOW_MINUTES: string; // hur länge efter avspark en match anses pågå
  KICKOFF_LEAD_SECONDS: string; // hur långt före avspark loopen vaknar
  IDLE_MAX_SLEEP_SECONDS: string; // max sovtid mellan matcher (schemakoll, inget API-anrop)
  COMPANY_NAME?: string; // företaget tipset körs på (Arne nämner det i referaten)
  GEMINI_MODEL: string; // primär referat-modell, t.ex. "gemini-3.5-flash"
  GEMINI_MODELS?: string; // kommaseparerad fallback-kedja (egen kvot per modell)
  GEMINI_FALLBACK_MODEL?: string; // (äldre) enskild fallback
  GOOGLE_GENERATIVE_AI_API_KEY?: string; // saknas => referat hoppas över (vanligt meddelande)
}

/** En matchhändelse från API-Football (mål, kort, byte …). */
export interface MatchEvent {
  type: string; // "Goal", "Card", "subst", "Var"
  detail: string; // "Normal Goal", "Penalty", "Own Goal", "Yellow Card" …
  team: string;
  player: string;
  assist?: string;
  elapsed: number | null;
}

export interface Score {
  home: number;
  away: number;
}

/** Lagstatistik från /fixtures/statistics (per lag). null = saknas/0 i feeden. */
export interface TeamStats {
  possession: string | null; // "76%"
  totalShots: number | null;
  shotsOnGoal: number | null;
  corners: number | null;
  saves: number | null;
  xg: string | null; // expected_goals, "1.63"
}

export interface MatchStats {
  home: TeamStats;
  away: TeamStats;
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
  events?: MatchEvent[];
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
