// GoalWatcher: singleton-Durable-Object som pollar API-Football, upptäcker händelser
// (mål, halvtid, fulltid, röda kort), rättar tipsen, låter Arne kommentera och postar
// till Slack. Entrådig => ingen kapplöpning om "förra ställningen".

import { DurableObject } from "cloudflare:workers";
import type { Env, LiveMatch, MatchResult, Score } from "./types";
import { ApiFootball } from "./apifootball";
import { applyLiveSnapshot, finalizeGone, diffEvents, type Change } from "./engine";
import { computeStandings, gradeMatch, isExact, type StandingRow } from "./scoring";
import { players, predictionsByMatch, keyOfLive, displayNames, fixtures, kickoffs } from "./predictions";
import { scheduleState, toKickoffMs } from "./schedule";
import { toSwedish } from "./teams";
import { buildGoalMessage, postSlack, type GoalView, type MatchPointRow } from "./slack";
import { generateCommentary, type CommentaryContext, type TipperView } from "./commentary";

const KICKOFFS_MS = toKickoffMs(kickoffs);
type Preds = ReturnType<typeof predictionsByMatch>;

export class GoalWatcher extends DurableObject<Env> {
  private api(): ApiFootball {
    return new ApiFootball(this.env.APISPORTS_HOST, this.env.APISPORTS_KEY);
  }
  private leagueId(): number {
    return Number(this.env.WC_LEAGUE_ID);
  }

  // ── Schemaläggning ────────────────────────────────────────────────────────
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
      try {
        const api = this.api();
        const live = await api.liveFixtures(this.leagueId());
        await this.process(api, live);
      } catch (e) {
        console.error("alarm-fel:", (e as Error).message);
      }
      nextAlarm = Date.now() + Number(this.env.POLL_SECONDS) * 1000;
    } else {
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
    const seenEvents = new Set<string>((await this.ctx.storage.get<string[]>("seenEvents")) ?? []);

    // Matcher vi ser för första gången => seeda events tyst (inga gamla röda kort).
    const baselineKeys = new Set<string>(live.map(keyOfLive).filter((k) => !prevResults[k]));

    const diff = applyLiveSnapshot(prevResults, prevLiveKeys, live, keyOfLive);

    // Finalisera matcher som fallit ur live-listan.
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

    // Övriga dramatiska händelser (röda kort, missade straffar).
    const ev = diffEvents(seenEvents, live, keyOfLive, baselineKeys);

    const changes: Change[] = [...diff.changes, ...ev.changes, ...finalChanges];

    await this.ctx.storage.put("results", diff.results);
    await this.ctx.storage.put("liveKeys", diff.liveKeys);
    await this.ctx.storage.put("seenEvents", [...ev.seen]);

    if (changes.length === 0) return 0;

    const preds = predictionsByMatch();
    const prevRanking = rankingMap(await this.loadRanking());
    const standings = computeStandings(players, preds, scoreMap(diff.results), new Map(), prevRanking);
    const leader = standings[0]?.player;
    const movers = standings
      .filter((r) => r.delta !== 0)
      .slice(0, 3)
      .map((r) => `${r.player} ${r.delta > 0 ? "▲" + r.delta : "▼" + -r.delta}`)
      .join(", ");

    let postedTable = false;
    for (const c of changes) {
      const names = displayNames(c.key, c.match);
      const commentary = await generateCommentary(this.env, this.contextFor(c, names, preds, leader, movers));
      const view: GoalView = {
        kind: c.kind,
        homeName: names.home,
        awayName: names.away,
        score: c.match.score,
        minute: c.match.elapsed,
        scorer: c.scorer,
        detail: c.detail,
        team: c.team ? toSwedish(c.team) : undefined,
        commentary,
      };
      // Under matchen: bara rubrik + Arne. Vid full tid: matchpoäng + totalställning.
      if (c.kind === "fulltime") {
        const matchPoints = this.matchPointsFor(c.key, c.match.score, preds);
        await postSlack(this.env, buildGoalMessage(view, { standings, matchPoints }));
        postedTable = true;
      } else {
        await postSlack(this.env, buildGoalMessage(view));
      }
    }

    // Uppdatera "senast visade" placering bara när tabellen faktiskt visats (vid FT),
    // så pilarna vid full tid speglar rörelsen sedan förra full tid.
    if (postedTable) {
      const newRanking: Record<string, number> = {};
      for (const r of standings) newRanking[r.player] = r.rank;
      await this.ctx.storage.put("ranking", newRanking);
    }

    return changes.length;
  }

  /** Poäng varje spelare fick i en enskild match (för full tid-kortet). */
  private matchPointsFor(key: string, score: Score, preds: Preds): MatchPointRow[] {
    const rows: MatchPointRow[] = [];
    for (const [player, pred] of preds.get(key) ?? []) {
      rows.push({ player, points: gradeMatch(pred, score) });
    }
    return rows.sort((a, b) => b.points - a.points);
  }

  private contextFor(
    c: Change,
    names: { home: string; away: string },
    preds: Preds,
    leader: string | undefined,
    movers: string,
  ): CommentaryContext {
    const tippers: TipperView[] = [];
    const byPlayer = preds.get(c.key);
    if (byPlayer) {
      for (const [player, pred] of byPlayer) {
        const outcome = isExact(pred, c.match.score)
          ? "exakt"
          : gradeMatch(pred, c.match.score) > 0
            ? "rätt tecken"
            : "fel";
        tippers.push({ player, pred: `${pred.home}-${pred.away}`, outcome });
      }
    }
    const f = fixtures[c.key];
    return {
      kind: c.kind,
      home: names.home,
      away: names.away,
      score: c.match.score,
      prev: c.prev,
      minute: c.match.elapsed,
      round: f ? `Grupp ${f.group}` : c.match.round,
      scorer: c.scorer,
      assist: c.assist,
      detail: c.detail,
      team: c.team ? toSwedish(c.team) : undefined,
      tippers,
      leader,
      movers,
    };
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
