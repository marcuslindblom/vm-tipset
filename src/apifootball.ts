// Tunn, host-agnostisk klient mot API-Football.
// Funkar både direkt (v3.football.api-sports.io, x-apisports-key) och via
// RapidAPI (api-football-v1.p.rapidapi.com/v3, x-rapidapi-key).

import type { LiveMatch, MatchStats, TeamStats } from "./types";

function buildHeaders(host: string, key: string): Record<string, string> {
  if (host.includes("rapidapi")) {
    return { "x-rapidapi-key": key, "x-rapidapi-host": new URL(host).host };
  }
  return { "x-apisports-key": key };
}

function mapFixture(f: any): LiveMatch {
  return {
    fixtureId: f.fixture.id,
    leagueId: f.league.id,
    round: f.league.round ?? "",
    date: f.fixture.date,
    home: { id: f.teams.home.id, name: f.teams.home.name },
    away: { id: f.teams.away.id, name: f.teams.away.name },
    score: { home: f.goals.home ?? 0, away: f.goals.away ?? 0 },
    status: f.fixture.status.short,
    elapsed: f.fixture.status.elapsed ?? null,
    winner: f.teams.home?.winner ? f.teams.home.name : f.teams.away?.winner ? f.teams.away.name : null,
    events: (f.events ?? []).map((e: any) => ({
      type: e.type ?? "",
      detail: e.detail ?? "",
      team: e.team?.name ?? "",
      player: e.player?.name ?? "",
      assist: e.assist?.name || undefined,
      elapsed: e.time?.elapsed ?? null,
    })),
  };
}

/** Plockar ut de fält vi bryr oss om ur ett lags statistik-block. */
function mapTeamStats(block: any): TeamStats {
  const by: Record<string, any> = {};
  for (const s of block?.statistics ?? []) by[s.type] = s.value;
  const num = (v: any): number | null => (v == null ? null : typeof v === "number" ? v : Number(v));
  return {
    possession: by["Ball Possession"] ?? null,
    totalShots: num(by["Total Shots"]),
    shotsOnGoal: num(by["Shots on Goal"]),
    corners: num(by["Corner Kicks"]),
    saves: num(by["Goalkeeper Saves"]),
    xg: by["expected_goals"] ?? null,
  };
}

export class ApiFootball {
  constructor(
    private readonly host: string,
    private readonly key: string,
  ) {}

  private async get(path: string): Promise<any> {
    const res = await fetch(`${this.host}${path}`, {
      headers: buildHeaders(this.host, this.key),
    });
    if (!res.ok) throw new Error(`API-Football HTTP ${res.status} för ${path}`);
    const json: any = await res.json();
    if (json.errors && !Array.isArray(json.errors) && Object.keys(json.errors).length) {
      throw new Error(`API-Football fel: ${JSON.stringify(json.errors)}`);
    }
    return json;
  }

  /** Kontoinfo + kvot. */
  async status(): Promise<any> {
    return (await this.get("/status")).response;
  }

  /** Alla pågående matcher i en liga (ett anrop returnerar alla live-matcher globalt). */
  async liveFixtures(leagueId: number): Promise<LiveMatch[]> {
    const json = await this.get("/fixtures?live=all");
    return (json.response as any[]).map(mapFixture).filter((m) => m.leagueId === leagueId);
  }

  /** En enskild match (används för att finalisera en match som fallit ur live-listan). */
  async fixtureById(id: number): Promise<LiveMatch | null> {
    const json = await this.get(`/fixtures?id=${id}`);
    const f = (json.response as any[])[0];
    return f ? mapFixture(f) : null;
  }

  /** Alla matcher i ligan/säsongen (ett anrop) – används för att härleda slutspelsträdet. */
  async seasonFixtures(leagueId: number, season: number | string): Promise<LiveMatch[]> {
    const json = await this.get(`/fixtures?league=${leagueId}&season=${season}`);
    return (json.response as any[]).map(mapFixture);
  }

  /** Skytteligan – första posten är skyttekungen. */
  async topScorers(leagueId: number, season: number | string): Promise<{ player: string; goals: number }[]> {
    const json = await this.get(`/players/topscorers?league=${leagueId}&season=${season}`);
    // `player.name` är "förnamnsinitial + vanligt efternamn" ("L. Messi"), vilket samePlayer
    // matchar mot Excels fulla namn. (firstname/lastname ger juridiskt fullnamn med
    // sammansatt efternamn, t.ex. "Messi Cuccittini" – sämre för matchning.)
    return (json.response as any[]).map((r) => ({
      player: r.player?.name ?? "",
      goals: r.statistics?.[0]?.goals?.total ?? 0,
    }));
  }

  /** Lagstatistik för en match (bollinnehav, skott, xG …). Hämtas vid halvtid/full tid. */
  async statsByFixture(fixtureId: number, homeName: string): Promise<MatchStats | null> {
    const json = await this.get(`/fixtures/statistics?fixture=${fixtureId}`);
    const arr = json.response as any[];
    if (!arr || arr.length < 2) return null;
    // Statistik-svaret säger inte hem/borta – matcha på lagnamn (fall tillbaka på ordning).
    const home = arr.find((b) => b.team?.name === homeName) ?? arr[0];
    const away = arr.find((b) => b !== home) ?? arr[1];
    return { home: mapTeamStats(home), away: mapTeamStats(away) };
  }
}
