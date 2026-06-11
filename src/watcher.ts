// GoalWatcher: en singleton-Durable-Object som pollar API-Football, upptäcker mål,
// rättar tipsen och postar ställningen till Slack. Entrådig => ingen kapplöpning om
// "förra ställningen".

import { DurableObject } from "cloudflare:workers";
import type { Env, LiveMatch, MatchResult, Score } from "./types";
import { ApiFootball } from "./apifootball";
import { applyLiveSnapshot, finalizeGone, type Change } from "./engine";
import { computeStandings, type StandingRow } from "./scoring";
import { players, predictionsByMatch, keyOfLive, displayNames, kickoffs } from "./predictions";
import { scheduleState, toKickoffMs } from "./schedule";
import { buildGoalMessage, postSlack, type GoalView } from "./slack";

// Avsparkstiderna är statiska – tolka en gång.
const KICKOFFS_MS = toKickoffMs(kickoffs);

export class GoalWatcher extends DurableObject<Env> {
  private api(): ApiFootball {
    return new ApiFootball(this.env.APISPORTS_HOST, this.env.APISPORTS_KEY);
  }
  private leagueId(): number {
    return Number(this.env.WC_LEAGUE_ID);
  }

  // ── Schemaläggning ────────────────────────────────────────────────────────
  /** Heartbeat från cron: starta loopen om den inte redan är armerad. */
  async ensureAlarm(): Promise<{ scheduled: boolean }> {
    const cur = await this.ctx.storage.getAlarm();
    if (cur == null) {
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return { scheduled: true };
    }
    return { scheduled: false };
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const windowMs = Number(this.env.MATCH_WINDOW_MINUTES) * 60_000;
    const leadMs = Number(this.env.KICKOFF_LEAD_SECONDS) * 1000;
    const { anyLive, nextKickoffMs } = scheduleState(KICKOFFS_MS, now, windowMs, leadMs);

    let nextAlarm: number;
    if (anyLive) {
      // Inom ett matchfönster: polla och boka nästa pollning om POLL_SECONDS.
      try {
        const api = this.api();
        const live = await api.liveFixtures(this.leagueId());
        await this.process(api, live);
      } catch (e) {
        console.error("alarm-fel:", (e as Error).message);
      }
      nextAlarm = Date.now() + Number(this.env.POLL_SECONDS) * 1000;
    } else {
      // Ingen match nu: sov fram till nästa avspark (minus lead) – INGET API-anrop.
      // Cappas så vi schemakollar minst varje IDLE_MAX_SLEEP_SECONDS.
      const idleCap = now + Number(this.env.IDLE_MAX_SLEEP_SECONDS) * 1000;
      const wake = nextKickoffMs != null ? nextKickoffMs - leadMs : idleCap;
      nextAlarm = Math.min(Math.max(wake, now + 1000), idleCap);
    }
    await this.ctx.storage.setAlarm(nextAlarm);
  }

  // ── Operations-/test-RPC ──────────────────────────────────────────────────
  async pollNow(): Promise<{ live: number; changes: number }> {
    const api = this.api();
    const live = await api.liveFixtures(this.leagueId());
    const n = await this.process(api, live);
    return { live: live.length, changes: n };
  }

  /** Injicera ett syntetiskt live-snapshot (test/dev, utan riktiga API-anrop). */
  async injectSnapshot(live: LiveMatch[]): Promise<{ changes: number }> {
    const n = await this.process(null, live);
    return { changes: n };
  }

  async getStandings(): Promise<StandingRow[]> {
    const results = await this.loadResults();
    return computeStandings(players, predictionsByMatch(), scoreMap(results));
  }

  async reset(): Promise<{ reset: true }> {
    await this.ctx.storage.deleteAll();
    return { reset: true };
  }

  // ── Kärna ─────────────────────────────────────────────────────────────────
  private async process(api: ApiFootball | null, live: LiveMatch[]): Promise<number> {
    const prevResults = await this.loadResults();
    const prevLiveKeys = (await this.ctx.storage.get<string[]>("liveKeys")) ?? [];

    const diff = applyLiveSnapshot(prevResults, prevLiveKeys, live, keyOfLive);

    // Finalisera matcher som fallit ur live-listan (hämta slutstatus om möjligt).
    const fetched = new Map<string, LiveMatch | null>();
    for (const key of diff.goneKeys) {
      const prev = diff.results[key];
      let fin: LiveMatch | null = null;
      if (api && prev?.fixtureId) {
        try {
          fin = await api.fixtureById(prev.fixtureId);
        } catch {
          fin = null;
        }
      }
      fetched.set(key, fin);
    }
    const finalChanges = finalizeGone(diff.results, diff.goneKeys, fetched);
    const changes: Change[] = [...diff.changes, ...finalChanges];

    await this.ctx.storage.put("results", diff.results);
    await this.ctx.storage.put("liveKeys", diff.liveKeys);

    if (changes.length === 0) return 0;

    const prevRanking = rankingMap(await this.loadRanking());
    const standings = computeStandings(
      players,
      predictionsByMatch(),
      scoreMap(diff.results),
      new Map(),
      prevRanking,
    );

    for (const c of changes) {
      const names = displayNames(c.key, c.match);
      const view: GoalView = {
        homeName: names.home,
        awayName: names.away,
        score: c.match.score,
        prevScore: c.prev,
        minute: c.match.elapsed,
        finished: c.finished,
        disallowed: c.disallowed,
      };
      await postSlack(this.env, buildGoalMessage(view, standings));
    }

    const newRanking: Record<string, number> = {};
    for (const r of standings) newRanking[r.player] = r.rank;
    await this.ctx.storage.put("ranking", newRanking);

    return changes.length;
  }

  private async loadResults(): Promise<Record<string, MatchResult>> {
    return (await this.ctx.storage.get<Record<string, MatchResult>>("results")) ?? {};
  }
  private async loadRanking(): Promise<Record<string, number>> {
    return (await this.ctx.storage.get<Record<string, number>>("ranking")) ?? {};
  }
}

function scoreMap(results: Record<string, MatchResult>): Map<string, Score> {
  const m = new Map<string, Score>();
  for (const [k, r] of Object.entries(results)) m.set(k, r.score);
  return m;
}
function rankingMap(obj: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(obj));
}
