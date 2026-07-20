// Worker-entry: HTTP-routes för drift/test + cron-heartbeat som håller poll-loopen vid liv.

import type { Env, LiveMatch } from "./types";
import { GoalWatcher } from "./watcher";
import { fixtures, keyBy, kickoffs } from "./predictions";
import { scheduleState, toKickoffMs } from "./schedule";
import { generateCommentary } from "./commentary";
import { verifySlackSignature } from "./slackapi";

const KICKOFFS_MS = toKickoffMs(kickoffs);

export { GoalWatcher };

function watcher(env: Env): DurableObjectStub<GoalWatcher> {
  return env.WATCHER.get(env.WATCHER.idFromName("vm-2026")) as DurableObjectStub<GoalWatcher>;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Bygg ett syntetiskt live-snapshot från en match i tipsdatan (för /test/goal). */
function syntheticMatch(key: string, home: number, away: number, status: string, elapsed: number): LiveMatch {
  const f = fixtures[key];
  if (!f) throw new Error(`okänd matchnyckel: ${key}`);
  return {
    fixtureId: f.fixtureId ?? 900000,
    leagueId: 1,
    round: f.group ? `Group ${f.group}` : "",
    date: "",
    home: { id: 0, name: f.home },
    away: { id: 0, name: f.away },
    score: { home, away },
    status,
    elapsed,
  };
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const w = watcher(env);

    // Slack Events API: @arne-omnämnanden (verifiera signatur, ack:a snabbt).
    if (url.pathname === "/slack/events" && req.method === "POST") {
      const raw = await req.text();
      if (!env.SLACK_SIGNING_SECRET) return new Response("ej konfigurerad", { status: 503 });
      const ok = await verifySlackSignature(
        env.SLACK_SIGNING_SECRET,
        req.headers.get("x-slack-request-timestamp") ?? "",
        raw,
        req.headers.get("x-slack-signature") ?? "",
      );
      if (!ok) return new Response("ogiltig signatur", { status: 401 });

      const body: any = JSON.parse(raw);
      if (body.type === "url_verification") return json({ challenge: body.challenge });
      if (req.headers.get("x-slack-retry-num")) return new Response("ok"); // hoppa över retries
      if (body.type === "event_callback" && body.event?.type === "app_mention") {
        const e = body.event;
        const text = String(e.text ?? "").replace(/<@[^>]+>/g, "").trim();
        // Svara publikt och platt i kanalflödet.
        ctx.waitUntil(w.handleMention(e.channel, e.user, text));
      }
      return new Response("ok");
    }

    switch (url.pathname) {
      case "/health": {
        const now = Date.now();
        const { anyLive, nextKickoffMs } = scheduleState(
          KICKOFFS_MS,
          now,
          Number(env.MATCH_WINDOW_MINUTES) * 60_000,
          Number(env.KICKOFF_LEAD_SECONDS) * 1000,
        );
        return json({
          ok: true,
          keyBy,
          matches: Object.keys(fixtures).length,
          kickoffs: KICKOFFS_MS.length,
          polling: anyLive,
          nextKickoff: nextKickoffMs ? new Date(nextKickoffMs).toISOString() : null,
        });
      }

      case "/standings":
        return json(await w.getStandings());

      case "/debug":
        return json(await w.debugState());

      case "/start":
        return json(await w.ensureAlarm());

      case "/poll":
        return json(await w.pollNow());

      case "/reset":
        if (req.method !== "POST") return json({ error: "POST krävs" }, 405);
        return json(await w.reset());

      case "/backfill-knockout":
        // Engångs: hämtar rond+vinnare för redan spelade slutspelsmatcher via fixtureById.
        if (req.method !== "POST") return json({ error: "POST krävs" }, 405);
        return json(await w.backfillKnockout());

      case "/set-topscorer": {
        // Manuell skyttekung (Free-planen saknar skytteliga): ?player=...&goals=N
        if (req.method !== "POST") return json({ error: "POST krävs" }, 405);
        const player = url.searchParams.get("player");
        const goals = Number(url.searchParams.get("goals"));
        if (!player || Number.isNaN(goals)) return json({ error: "player och goals krävs" }, 400);
        return json(await w.setTopScorer(player, goals));
      }

      case "/set-champion": {
        // Manuell mästare (säkerhet om finalen ej lagras med vinnare): ?team=Spain
        if (req.method !== "POST") return json({ error: "POST krävs" }, 405);
        const team = url.searchParams.get("team");
        if (!team) return json({ error: "team krävs" }, 400);
        return json(await w.setChampion(team));
      }

      case "/set-total-goals": {
        // Utslagsfrågan: verkligt totalt målantal (ordinarie + förlängning, ej straffar): ?goals=N
        if (req.method !== "POST") return json({ error: "POST krävs" }, 405);
        const goals = Number(url.searchParams.get("goals"));
        if (Number.isNaN(goals)) return json({ error: "goals krävs" }, 400);
        return json(await w.setTotalGoals(goals));
      }

      case "/final-summary": {
        // Postar avslutnings-toasten till Slack: ?champion=Spain&final=Spanien 1-0 Argentina (e.förl.)
        if (req.method !== "POST") return json({ error: "POST krävs" }, 405);
        const champion = url.searchParams.get("champion") ?? "Spain";
        const final = url.searchParams.get("final") ?? "";
        const dry = url.searchParams.get("dry") === "1"; // förhandsvisa utan att posta
        return json(await w.postFinalSummary(champion, final, dry));
      }

      case "/test/commentary": {
        // Genererar ETT exempel-referat och returnerar det (postar inget till Slack).
        const started = Date.now();
        const text = await generateCommentary(env, {
          kind: "goal",
          home: "Brasilien",
          away: "Serbien",
          score: { home: 2, away: 1 },
          minute: 78,
          round: "Grupp C",
          scorer: "Vinícius Jr",
          assist: "Rodrygo",
          tippers: [
            { player: "Adam", pred: "2-1", outcome: "exakt" },
            { player: "Marcus", pred: "0-0", outcome: "fel" },
          ],
          leader: "Adam",
          movers: "Adam ▲2, Marcus ▼1",
        });
        return json({
          model: env.GEMINI_MODEL,
          hasKey: Boolean(env.GOOGLE_GENERATIVE_AI_API_KEY),
          ms: Date.now() - started,
          commentary: text,
        });
      }

      case "/test/goal": {
        // Ex: /test/goal?key=<matchnyckel>&home=1&away=0&min=23
        const key = url.searchParams.get("key") ?? Object.keys(fixtures)[0];
        const home = Number(url.searchParams.get("home") ?? "1");
        const away = Number(url.searchParams.get("away") ?? "0");
        const min = Number(url.searchParams.get("min") ?? "10");
        const status = url.searchParams.get("status") ?? "1H";
        const snapshot = [syntheticMatch(key, home, away, status, min)];
        return json({ key, ...(await w.injectSnapshot(snapshot)) });
      }

      default:
        return new Response(
          "VM-tipset realtidsrättare\n\nRoutes: /health /standings /start /poll /test/goal /reset",
          { headers: { "content-type": "text/plain; charset=utf-8" } },
        );
    }
  },

  // Cron (var minut): säkerställ att poll-loopen lever – startar om den dött.
  async scheduled(_c: ScheduledController, env: Env): Promise<void> {
    await watcher(env).ensureAlarm();
  },
} satisfies ExportedHandler<Env>;
