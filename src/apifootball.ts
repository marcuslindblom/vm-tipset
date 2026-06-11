// Tunn, host-agnostisk klient mot API-Football.
// Funkar både direkt (v3.football.api-sports.io, x-apisports-key) och via
// RapidAPI (api-football-v1.p.rapidapi.com/v3, x-rapidapi-key).

import type { LiveMatch } from "./types";

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
}
