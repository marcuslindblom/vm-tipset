// GoalWatcher: singleton-Durable-Object som pollar API-Football, upptäcker händelser
// (mål, halvtid, fulltid, röda kort), rättar tipsen, låter Arne kommentera och postar
// till Slack. Entrådig => ingen kapplöpning om "förra ställningen".

import { DurableObject } from "cloudflare:workers";
import type { Env, LiveMatch, MatchResult, Score } from "./types";
import { isFinal } from "./types";
import { ApiFootball } from "./apifootball";
import { applyLiveSnapshot, finalizeGone, diffEvents, type Change } from "./engine";
import { computeStandings, gradeMatch, isExact, type StandingRow } from "./scoring";
import {
  computeExtraPoints,
  deriveKnockoutActual,
  toKnockoutActual,
  looksUnmatchedKnockout,
  EMPTY_ACTUAL,
  type StoredKnockoutActual,
} from "./bonus";
import { players, predictionsByMatch, knockoutPredictions, keyOfLive, displayNames, fixtures, kickoffs } from "./predictions";
import { scheduleState, toKickoffMs } from "./schedule";
import { toSwedish } from "./teams";
import { buildGoalMessage, buildLeadChangeMessage, postSlack, statsSummary, type GoalView, type MatchPointRow } from "./slack";
import { generateCommentary, answerAsArne, leadChangeCommentary, type CommentaryContext, type TipperView } from "./commentary";
import { postMessage } from "./slackapi";

const KICKOFFS_MS = toKickoffMs(kickoffs);
type Preds = ReturnType<typeof predictionsByMatch>;

export class GoalWatcher extends DurableObject<Env> {
  private api(): ApiFootball {
    return new ApiFootball(this.env.APISPORTS_HOST, this.env.APISPORTS_KEY);
  }
  private leagueId(): number {
    return Number(this.env.WC_LEAGUE_ID);
  }
  private season(): string {
    return this.env.SEASON;
  }

  // ── Bonuskanal: grupp-placering + slutspel + bonus ────────────────────────
  /** Hämta slutspelsträdet + skytteligan från API:t och spara serialiserat i DO-storage. */
  private async refreshKnockoutActual(api: ApiFootball): Promise<StoredKnockoutActual> {
    const fx = await api.seasonFixtures(this.leagueId(), this.season());
    // Larma om en slutspelsrond inte känns igen (annars faller poängen tyst bort).
    const unmatched = [...new Set(fx.map((f) => f.round))].filter(looksUnmatchedKnockout);
    if (unmatched.length) console.error("OMATCHADE slutspelsronder (ger 0 poäng!):", unmatched.join(" | "));
    const derived = deriveKnockoutActual(fx);
    try {
      const scorers = await api.topScorers(this.leagueId(), this.season());
      if (scorers[0]?.player) {
        derived.topScorer = scorers[0].player;
        derived.topScorerGoals = scorers[0].goals;
        console.log(`Skyttekung enligt API: ${scorers[0].player} (${scorers[0].goals} mål)`);
      }
    } catch (e) {
      console.error("topscorers-fel:", (e as Error).message);
    }
    await this.ctx.storage.put("knockoutActual", derived);
    return derived;
  }

  /**
   * extraPoints (grupp-placering + slutspel + bonus) per spelare. Läser lagrat
   * slutspelsträd; med en API-klient seedas det vid första anropet och uppdateras när
   * `forceRefresh` är satt (t.ex. när en slutspelsmatch rörts). Utan API-klient
   * (injektionstest) används enbart lagrad/​tom data.
   */
  private async buildExtraPoints(
    results: Record<string, MatchResult>,
    api: ApiFootball | null,
    forceRefresh = false,
  ): Promise<Map<string, number>> {
    let stored = await this.ctx.storage.get<StoredKnockoutActual>("knockoutActual");
    if (api && (forceRefresh || !stored)) {
      try {
        stored = await this.refreshKnockoutActual(api);
      } catch (e) {
        console.error("knockout-refresh-fel:", (e as Error).message);
      }
    }
    return computeExtraPoints({
      players,
      groupPreds: predictionsByMatch(),
      fixtures,
      results: scoreMap(results),
      knockoutPreds: knockoutPredictions(),
      knockoutActual: toKnockoutActual(stored ?? EMPTY_ACTUAL),
    });
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
    const extra = await this.buildExtraPoints(results, this.api());
    return computeStandings(players, predictionsByMatch(), scoreMap(results), extra);
  }

  async reset(): Promise<{ reset: true }> {
    await this.ctx.storage.deleteAll();
    return { reset: true };
  }

  /** Read-only ögonblicksbild av DO-tillståndet (drift/felsökning). */
  async debugState(): Promise<unknown> {
    const results = await this.loadResults();
    const liveKeys = (await this.ctx.storage.get<string[]>("liveKeys")) ?? [];
    const seen = (await this.ctx.storage.get<string[]>("seenEvents")) ?? [];
    const ranking = await this.loadRanking();
    const alarm = await this.ctx.storage.getAlarm();
    const rows = Object.entries(results).map(([key, r]) => ({
      key,
      match: `${r.home} ${r.score.home}-${r.score.away} ${r.away}`,
      status: r.status,
      final: r.final,
      live: liveKeys.includes(key),
    }));
    return {
      now: new Date().toISOString(),
      alarm: alarm ? new Date(alarm).toISOString() : null,
      liveKeys,
      resultsCount: rows.length,
      finalizedCount: rows.filter((r) => r.final).length,
      pendingFinalize: rows.filter((r) => !r.final).map((r) => `${r.key} (${r.match}, ${r.status}, live=${r.live})`),
      results: rows,
      seenEventsCount: seen.length,
      hasRanking: Object.keys(ranking).length > 0,
    };
  }

  // ── @arne-assistent (publika svar i kanalen) ──────────────────────────────
  async handleMention(channel: string, user: string, text: string): Promise<void> {
    const token = this.env.SLACK_BOT_TOKEN;
    if (!token) {
      console.error("SLACK_BOT_TOKEN saknas – kan inte svara på @arne");
      return;
    }
    const usersMap = (await this.ctx.storage.get<Record<string, string>>("slackUsers")) ?? {};

    // Onboarding: "jag heter/är X" => koppla Slack-användare till spelare.
    const m = /\bjag\s+(?:heter|är|e)\s+([\p{L}-]+)/iu.exec(text);
    if (m) {
      const player = matchPlayer(m[1]);
      if (player) {
        usersMap[user] = player;
        await this.ctx.storage.put("slackUsers", usersMap);
        await postMessage(token, channel, `Hej ${player}! Nu känner jag igen dig. Fråga mig t.ex. "hur har jag tippat?" eller "ställningen".`);
      } else {
        await postMessage(token, channel, `Hmm, jag hittar ingen spelare som heter "${m[1]}". Spelare i tipset: ${players.join(", ")}.`);
      }
      return;
    }

    // Auto-koppla via Slack-namnet (matchar tipsnamnet, ev. annat skiftläge).
    const player = usersMap[user] ?? (await this.resolvePlayer(token, user, usersMap));
    if (!player) {
      await postMessage(token, channel, `<@${user}> jag känner inte igen ditt namn automatiskt. Skriv "@arne jag heter <ditt namn>". Spelare: ${players.join(", ")}.`);
      return;
    }

    await postMessage(token, channel, await this.answer(player, text));
  }

  /** Slå upp Slack-användarens namn och matcha mot en spelare (skiftlägesokänsligt). */
  private async resolvePlayer(token: string, user: string, usersMap: Record<string, string>): Promise<string | null> {
    try {
      const res = await fetch(`https://slack.com/api/users.info?user=${user}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const j: any = await res.json();
      if (!j.ok) return null;
      const p = j.user?.profile ?? {};
      const candidates = [p.display_name, j.user?.name, p.real_name, String(p.real_name ?? "").split(" ")[0]];
      for (const c of candidates) {
        const match = c ? matchPlayer(c) : null;
        if (match) {
          usersMap[user] = match;
          await this.ctx.storage.put("slackUsers", usersMap);
          return match;
        }
      }
    } catch (e) {
      console.error("users.info fel:", (e as Error).message);
    }
    return null;
  }

  private async answer(player: string, question: string): Promise<string> {
    const results = await this.loadResults();
    const preds = predictionsByMatch();
    const extra = await this.buildExtraPoints(results, this.api());
    const standings = computeStandings(players, preds, scoreMap(results), extra);
    const myMatches = await this.myMatchesSummary(player, preds, results);
    const standingsSummary = standings.map((r) => `${r.rank}. ${r.player} — ${r.points} p`).join("\n");

    const allTips = await this.allTipsSummary(preds, results);

    const arne = await answerAsArne(this.env, { player, question, myMatches, allTips, standings: standingsSummary });
    if (arne) return arne;

    // Fallback om Gemini är nere: leverera datan rakt.
    const me = standings.find((r) => r.player === player);
    return (
      `Dina tips:\n${myMatches}\n\nAllas tips (pågående/nästa):\n${allTips}\n\nTotalställning:\n${standingsSummary}` +
      (me ? `\n\nDu (${player}) ligger ${me.rank}:a med ${me.points} p.` : "")
    );
  }

  /** Allas tippade resultat för pågående + nästa match. */
  private async allTipsSummary(preds: Preds, results: Record<string, MatchResult>): Promise<string> {
    const liveKeys = (await this.ctx.storage.get<string[]>("liveKeys")) ?? [];
    const rows: { key: string; label: string }[] = [];
    for (const key of liveKeys) {
      const f = fixtures[key];
      if (!f) continue;
      const cur = results[key]?.score;
      rows.push({ key, label: `${f.homeSv}–${f.awaySv} (PÅGÅR${cur ? `, just nu ${cur.home}-${cur.away}` : ""})` });
    }
    const nowMs = Date.now();
    let nextKey: string | null = null;
    let nextT = Infinity;
    for (const [key, f] of Object.entries(fixtures)) {
      const t = f.kickoff ? Date.parse(f.kickoff) : NaN;
      if (!Number.isNaN(t) && t > nowMs && t < nextT && preds.has(key)) {
        nextKey = key;
        nextT = t;
      }
    }
    if (nextKey && !liveKeys.includes(nextKey)) {
      const f = fixtures[nextKey];
      rows.push({ key: nextKey, label: `${f.homeSv}–${f.awaySv} (NÄSTA)` });
    }
    if (!rows.length) return "Inga pågående eller kommande matcher just nu.";

    return rows
      .map(({ key, label }) => {
        const byPlayer = preds.get(key);
        const tips = players
          .map((pl) => {
            const p = byPlayer?.get(pl);
            return p ? `${pl} ${p.home}-${p.away}` : null;
          })
          .filter(Boolean)
          .join(", ");
        return `${label}: ${tips}`;
      })
      .join("\n");
  }

  private async myMatchesSummary(
    player: string,
    preds: Preds,
    results: Record<string, MatchResult>,
  ): Promise<string> {
    const liveKeys = (await this.ctx.storage.get<string[]>("liveKeys")) ?? [];
    const lines: string[] = [];
    for (const key of liveKeys) {
      const p = preds.get(key)?.get(player);
      const f = fixtures[key];
      if (p && f) {
        const cur = results[key]?.score;
        lines.push(
          `PÅGÅR: ${f.homeSv}–${f.awaySv}, ditt tips ${p.home}-${p.away}${cur ? `, just nu ${cur.home}-${cur.away}` : ""}`,
        );
      }
    }
    const nowMs = Date.now();
    let next: { f: (typeof fixtures)[string]; ph: number; pa: number; t: number } | null = null;
    for (const [key, f] of Object.entries(fixtures)) {
      const p = preds.get(key)?.get(player);
      const t = f.kickoff ? Date.parse(f.kickoff) : NaN;
      if (p && !Number.isNaN(t) && t > nowMs && (!next || t < next.t)) next = { f, ph: p.home, pa: p.away, t };
    }
    if (next) {
      const when = new Date(next.t).toISOString().slice(0, 16).replace("T", " ");
      lines.push(`NÄSTA: ${next.f.homeSv}–${next.f.awaySv}, ditt tips ${next.ph}-${next.pa} (avspark ${when} UTC)`);
    }
    if (!lines.length) lines.push("Inga pågående eller kommande matcher just nu.");
    return lines.join("\n");
  }

  // ── Kärna ─────────────────────────────────────────────────────────────────
  private async process(api: ApiFootball | null, live: LiveMatch[]): Promise<number> {
    const prevResults = await this.loadResults();
    const prevLiveKeys = (await this.ctx.storage.get<string[]>("liveKeys")) ?? [];
    const seenEvents = new Set<string>((await this.ctx.storage.get<string[]>("seenEvents")) ?? []);

    // Matcher vi ser för första gången => seeda events tyst (inga gamla röda kort).
    const baselineKeys = new Set<string>(live.map(keyOfLive).filter((k) => !prevResults[k]));

    const diff = applyLiveSnapshot(prevResults, prevLiveKeys, live, keyOfLive);

    // Finalisera matcher som fallit ur live-listan (hämta slutresultat per id).
    const fetched = new Map<string, LiveMatch | null>();
    for (const key of diff.goneKeys) fetched.set(key, await this.fetchFixture(api, diff.results[key]));
    const { changes: finalChanges, keepLive } = finalizeGone(diff.results, diff.goneKeys, fetched);
    // Matcher som ännu visas pågående i fixtures-feeden (blip/eftersläpning): fortsätt bevaka,
    // så de inte tappas ur liveKeys och fastnar icke-finala.
    for (const key of keepLive) diff.liveKeys.push(key);

    // Självläkande: tyst-finalisera matcher vars fönster passerat men som fastnat icke-final
    // (t.ex. om feed-eftersläpning sammanföll med ett schemaglapp). Postar inget till Slack.
    await this.sweepStuck(api, diff.results, diff.liveKeys);

    // Övriga dramatiska händelser (röda kort, missade straffar).
    const ev = diffEvents(seenEvents, live, keyOfLive, baselineKeys);

    const changes: Change[] = [...diff.changes, ...ev.changes, ...finalChanges];

    await this.ctx.storage.put("results", diff.results);
    await this.ctx.storage.put("liveKeys", diff.liveKeys);
    await this.ctx.storage.put("seenEvents", [...ev.seen]);

    if (changes.length === 0) return 0;

    const preds = predictionsByMatch();
    const prevRanking = rankingMap(await this.loadRanking());
    // Uppdatera slutspelsträdet när en slutspelsmatch (saknar grupp-fixture) just kickat/slutat.
    const knockoutTouched = changes.some((c) => !fixtures[c.key] && (c.kind === "fulltime" || c.kind === "kickoff"));
    const extra = await this.buildExtraPoints(diff.results, api, knockoutTouched);
    const standings = computeStandings(players, preds, scoreMap(diff.results), extra, prevRanking);
    const leader = standings[0]?.player;
    const movers = standings
      .filter((r) => r.delta !== 0)
      .slice(0, 3)
      .map((r) => `${r.player} ${r.delta > 0 ? "▲" + r.delta : "▼" + -r.delta}`)
      .join(", ");

    let postedTable = false;
    for (const c of changes) {
      const names = displayNames(c.key, c.match);
      // Vid halvtid/full tid: hämta lagstatistik så Arne kan krydda med en siffra.
      const statsText = await this.statsTextFor(c, api, names);
      const commentary = await generateCommentary(
        this.env,
        this.contextFor(c, names, preds, leader, movers, statsText),
      );
      const f = fixtures[c.key];
      const view: GoalView = {
        kind: c.kind,
        homeName: names.home,
        awayName: names.away,
        score: c.match.score,
        minute: c.match.elapsed,
        scorer: c.scorer,
        detail: c.detail,
        team: c.team ? toSwedish(c.team) : undefined,
        context: f ? `Grupp ${f.group} · VM 2026` : c.match.round ? `${c.match.round} · VM 2026` : "VM 2026",
        allTips: c.kind === "kickoff" ? tipsLine(c.key, preds) : undefined,
        statsText,
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

    // Ledarbyte i tipset: egen notis när någon ny petar sig upp på förstaplatsen.
    await this.maybeAnnounceLeadChange(standings, changes);

    // Uppdatera "senast visade" placering bara när tabellen faktiskt visats (vid FT),
    // så pilarna vid full tid speglar rörelsen sedan förra full tid.
    if (postedTable) {
      const newRanking: Record<string, number> = {};
      for (const r of standings) newRanking[r.player] = r.rank;
      await this.ctx.storage.put("ranking", newRanking);
    }

    return changes.length;
  }

  /**
   * Posta en notis när toppen av tipset ändras – men bara när någon SOM INTE ledde
   * tidigare nu är (delad) etta. Tyst första gången (ingen tidigare ledare lagrad).
   */
  private async maybeAnnounceLeadChange(standings: StandingRow[], changes: Change[]): Promise<void> {
    const leaders = standings.filter((r) => r.rank === 1).map((r) => r.player);
    if (leaders.length === 0) return;
    const previous = (await this.ctx.storage.get<string[]>("leaders")) ?? [];
    await this.ctx.storage.put("leaders", leaders);

    const prevSet = new Set(previous);
    const newcomers = leaders.filter((p) => !prevSet.has(p));
    if (previous.length === 0 || newcomers.length === 0) return; // första gången / ingen ny i topp

    // Mål-/VAR-händelsen som troligen orsakade skiftet (för Arnes färg).
    const trigger = changes.find((c) => c.kind === "goal" || c.kind === "disallowed" || c.kind === "fulltime");
    const triggerText = trigger
      ? (() => {
          const n = displayNames(trigger.key, trigger.match);
          return `${n.home} ${trigger.match.score.home}–${trigger.match.score.away} ${n.away}`;
        })()
      : undefined;

    const title =
      leaders.length === 1
        ? `👑 Nytt i toppen — ${leaders[0]} tar ledningen i tipset!`
        : `👑 Delad ledning — ${leaders.join(" & ")} toppar tipset!`;
    const standingsSummary = standings.map((r) => `${r.rank}. ${r.player} — ${r.points} p`).join("\n");
    const commentary = await leadChangeCommentary(this.env, {
      leaders,
      previous,
      newcomers,
      standings: standingsSummary,
      trigger: triggerText,
    });
    await postSlack(this.env, buildLeadChangeMessage(title, standings, commentary, "👑 Ledarbyte · VM-tipset"));
  }

  /** Hämta en match per id (för finalisering). Tyst null vid avsaknad/fel. */
  private async fetchFixture(api: ApiFootball | null, prev?: MatchResult): Promise<LiveMatch | null> {
    if (!api || !prev?.fixtureId) return null;
    try {
      return await api.fixtureById(prev.fixtureId);
    } catch {
      return null;
    }
  }

  /**
   * Tyst-finalisera matcher vars matchfönster passerat men som ännu är icke-finala och inte
   * längre live. Backstop för matcher som lämnat live utan att straddlas (feed-eftersläpning +
   * schemaglapp). Uppdaterar ställningen som final UTAN att posta något till Slack.
   */
  private async sweepStuck(
    api: ApiFootball | null,
    results: Record<string, MatchResult>,
    liveKeys: string[],
  ): Promise<void> {
    const windowMs = Number(this.env.MATCH_WINDOW_MINUTES) * 60_000;
    const liveSet = new Set(liveKeys);
    for (const [key, r] of Object.entries(results)) {
      if (r.final || liveSet.has(key) || !windowPassed(key, windowMs)) continue;
      const fin = await this.fetchFixture(api, r);
      results[key] =
        fin && isFinal(fin.status)
          ? { fixtureId: fin.fixtureId, home: fin.home.name, away: fin.away.name, score: fin.score, status: fin.status, final: true }
          : { ...r, final: true };
    }
  }

  /** Lagstatistik som läsbar rad – bara vid halvtid/full tid och när API:t finns. */
  private async statsTextFor(
    c: Change,
    api: ApiFootball | null,
    names: { home: string; away: string },
  ): Promise<string | undefined> {
    if (c.kind !== "halftime" && c.kind !== "fulltime") return undefined;
    if (!api || !c.match.fixtureId) return undefined;
    try {
      const stats = await api.statsByFixture(c.match.fixtureId, c.match.home.name);
      return stats ? (statsSummary(names.home, names.away, stats) ?? undefined) : undefined;
    } catch (e) {
      console.error("stats-fel:", (e as Error).message);
      return undefined;
    }
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
    statsText?: string,
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
      statsText,
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

/** Har matchens fönster (avspark + MATCH_WINDOW) passerat? Okänd avspark => anta ja. */
function windowPassed(key: string, windowMs: number): boolean {
  const iso = fixtures[key]?.kickoff;
  if (!iso) return true;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? true : Date.now() > t + windowMs;
}

/** Allas tippade resultat för en match: "Adam 2-0 · Anders 1-0 · …". */
function tipsLine(key: string, preds: Preds): string {
  const byPlayer = preds.get(key);
  return players
    .map((pl) => {
      const p = byPlayer?.get(pl);
      return p ? `${pl} ${p.home}-${p.away}` : null;
    })
    .filter(Boolean)
    .join(" · ");
}

/** Matcha ett inskrivet namn mot en spelare (skiftlägesokänsligt, prefix tillåtet). */
function matchPlayer(typed: string): string | null {
  const t = typed.trim().toLowerCase();
  return (
    players.find((p) => p.toLowerCase() === t) ?? players.find((p) => p.toLowerCase().startsWith(t)) ?? null
  );
}
