# VM-tipset 2026 – realtidsrättare

Pollar live-resultat från VM 2026, rättar allas tips **så fort det blir mål** och postar en
uppdaterad ställning till Slack-kanalen `vm-tipset`. Körs som en Cloudflare Worker med en
Durable Object som poll-loop.

```
Cron (var minut, heartbeat)
   └─► Durable Object  GoalWatcher  (singleton)
          alarm():  pollar BARA inom ett matchfönster (avsparkstider från Excel),
                    annars sover den fram till nästa avspark – inga API-anrop emellan.
          1. GET /fixtures?live=all          (ett anrop → alla live-matcher)
          2. jämför mot lagrad ställning  →  upptäck mål (även VAR-underkända)
          3. räkna om ställningen  →  posta till Slack (Block Kit)
          4. matchslut (FT)  →  lås resultatet
          5. boka nästa pollning (POLL_SECONDS) / sovtid (nästa avspark)
```

## Poängsystem

**Gruppspel** (rättas live vid varje mål):

| | Poäng |
|---|---|
| Exakt resultat | **5** |
| Rätt målskillnad | **3** |
| Rätt utfall (1X2) | **2** |
| Fel | 0 |

**Slutspel + bonus** (avgörs vid matchslut/turneringsslut, inte per mål): poäng per korrekt lag som
når en rond, samt VM-vinnare, skyttekung (+antal mål) och totalt antal mål.

> ⚠️ Slutspels- och bonusvikterna i `src/scoring.ts` (`KNOCKOUT_WEIGHTS`, `BONUS_WEIGHTS`) är
> **defaults** – Excel-arket anger inte poängvärdena. Bekräfta dem mot gruppens regler innan slutspelet.

## Snabbstart (utan kostnad, mot historisk data)

```bash
npm install
npm test            # rättningsmotor + live-motor (13 tester)
npm run import      # läser data/*.xlsx → src/data/predictions.json
npm run simulate    # spelar upp en matchdag mål-för-mål, visar Slack-poster + ställning
```

`npm run simulate` kör hela kedjan (samma motor som Workern) mot riktiga 2026-matcher och de
importerade tipsen – ingen API-nyckel eller Slack krävs.

## Slack-app

Skapa appen från manifestet `slack-app-manifest.yaml`:

1. <https://api.slack.com/apps> → **Create New App** → **From an app manifest**
2. Välj workspace, klistra in `slack-app-manifest.yaml`, skapa.
3. **Incoming Webhooks** → slå på → **Add New Webhook to Workspace** → välj `#vm-tipset` → kopiera URL.
4. `npx wrangler secret put SLACK_WEBHOOK_URL` (eller lägg i `.dev.vars` lokalt).

Utan `SLACK_WEBHOOK_URL` körs allt i **dry-run** (loggar i stället för att posta).

## Go-live (skarp turnering)

### Kvot (Free vs Pro)

Tjänsten pollar bara inom matchfönster (avsparkstider från Excel) – aldrig idle. Med `POLL_SECONDS=120`
blir det ~66 anrop per enskild match. Free-takets 100/dygn räcker därför för **öppningsmatchen**
(11 juni, 1 match) men inte för flermatchsdagar:

| Dag | Matcher | Anrop @120s |
|---|---|---|
| 11 juni | 1 | ~66 ✅ ryms i Free |
| 12–13 juni | 2 | ~132 ⚠ |
| 14/17 juni | 5 | ~330 ⚠ kräver Pro |

Glesare intervall hjälper inte meningsfullt: 5 matcher på en dag skulle kräva ~7 min mellan pollningar
för att rymmas i 100 – för långsamt för "realtid". **Free duger för att testa öppningsmatchen; gruppspelet
i övrigt kräver Pro.**

Free-planen kommer dessutom **inte** åt säsong 2026 via `fixtures?season=2026` (bara 2022–2024) – `live=all`
fungerar men Pro tar bort all osäkerhet. Inför turneringen:

1. **Uppgradera till API-Football Pro** ($19/mån) på <https://dashboard.api-football.com> – 15 s
   uppdatering, 7 500 anrop/dygn. Sänk då `POLL_SECONDS` till `20` i `wrangler.jsonc` för
   ~30–45 s måldetektering. (Free duger bara för öppningsmatchen / att bygga/testa.)
2. Sätt hemligheter:
   ```bash
   npx wrangler secret put APISPORTS_KEY
   npx wrangler secret put SLACK_WEBHOOK_URL
   ```
3. **Lås matcherna mot fixture-id** (mer robust än namnmatchning):
   ```bash
   APISPORTS_KEY=... npm run import -- --fixtures
   ```
   Hämtar 2026-spelschemat och nycklar tipsen på `fixtureId`. Skriptet varnar för ev. lagnamn som inte
   kunde mappas – lägg i så fall till dem i `src/teams.ts`.
4. Lägg fler spelares filer i `data/` (en `.xlsx` per person, t.ex. `… - Anna.xlsx`) och kör `import` igen.
5. Deploya och starta loopen:
   ```bash
   npm run deploy
   curl https://<worker>.workers.dev/start
   ```

`wrangler.jsonc` har redan `SEASON=2026` och `WC_LEAGUE_ID=1`. Cron-heartbeaten håller loopen vid liv.

## Routes (drift/test)

| Route | Gör |
|---|---|
| `GET /health` | status + antal matcher |
| `GET /standings` | aktuell ställning (JSON) |
| `GET /start` | armera poll-loopen (heartbeat) |
| `GET /poll` | tvinga en pollning nu |
| `GET /test/goal?key=<nyckel>&home=1&away=0&min=23` | injicera ett syntetiskt mål (dry-run-test) |
| `POST /reset` | nollställ lagrat tillstånd |

## Filöversikt

| Fil | Ansvar |
|---|---|
| `src/scoring.ts` | Rättning (5/3/2), ställning, slutspel/bonus – rena funktioner |
| `src/engine.ts` | Ändringsdetektering (mål, VAR, matchslut) – ren, delad med simulatorn |
| `src/watcher.ts` | `GoalWatcher` Durable Object: poll-loop, finalisering, RPC |
| `src/index.ts` | Worker: routes + cron-heartbeat |
| `src/apifootball.ts` | Host-agnostisk API-Football-klient (direkt eller RapidAPI) |
| `src/slack.ts` | Block Kit-meddelanden (målnotis + topplista) |
| `src/teams.ts` | Lagnamnsmappning svenska ↔ engelska/API |
| `src/predictions.ts` | Laddar `src/data/predictions.json` |
| `scripts/import.ts` | Excel → `predictions.json` (offline eller `--fixtures`) |
| `scripts/simulate.ts` | E2E-simulering av en matchdag |
| `slack-app-manifest.yaml` | Skapa Slack-appen från manifest |
