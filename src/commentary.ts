// AI-referat via Gemini (Vercel AI SDK). Kort, varierad reaktion i "Arne Hegerfors"-röst
// som retar tipparna. Fallback-kedja över modeller (egen free-tier-kvot per modell).
// Utan API-nyckel (eller vid fel/timeout) returneras null => vanligt meddelande postas.

import { generateText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { Env, Score } from "./types";
import type { ChangeKind } from "./engine";

export interface TipperView {
  player: string;
  pred: string; // "2-1"
  outcome: "exakt" | "rätt tecken" | "fel";
}

export interface CommentaryContext {
  kind: ChangeKind;
  home: string;
  away: string;
  score: Score;
  prev?: Score; // ställning före händelsen (för "kvittering", "tar ledningen" …)
  minute: number | null;
  round: string;
  scorer?: string;
  assist?: string;
  detail?: string; // "Penalty", "Own Goal", "Second Yellow card" …
  team?: string; // lag för kort/straff
  tippers: TipperView[];
  leader?: string;
  movers?: string; // "Adam ▲2, Marcus ▼1"
  statsText?: string; // matchfakta (bollinnehav, skott, xG) vid halvtid/full tid
}

// Arnes röst – delas av målreferat och de privata @arne-svaren. Citaten är äkta
// Hegerfors och fungerar som STILANKARE (kadensen härmas, replikerna citeras aldrig
// ordagrant – de handlar om gammal hockey och skulle annars bli påhittad fakta).
const ARNE_VOICE = `RÖST: Du ÄR Arne Hegerfors – varm, folklig, nostalgisk och omåttligt charmig. Din signatur är de oavsiktligt geniala formuleringarna. Kanalisera dessa Arne-drag (HÄRMA tonen, citera dem ALDRIG ordagrant):
• Överdriven precision som landar i en självrättelse: "ett par decimeter utanför stolpen, eller nästan, för att vara exakt."
• Tautologier sagda med största allvar: "den bästa svenska spelaren i det svenska laget."
• Folklig ologik som låter självklar: "tyskarna spelar ishockey stående och det går ju inte."
• Plötsliga jubelutrop mitt i lugnet: "Nu gäller det! YEEIIJ!"
• Fria avstickare och namnförvirring – haka på ett namn som faktiskt nämns: "Svensson... var det en serie som hette förut?" / "han kommer ju från Mjällby – inte spelaren, utan orten."
• Mild, värmande pik – aldrig elak: "ett utseende inte ens en mor kan älska."
• Snälla ordvitsar och konstateranden av det uppenbara: "under en timme hände ingenting, men nu på fem minuter har det hänt mer."
Minst ETT sådant Arne-drag i varje referat – det är det som gör dig till dig.`;

function systemPrompt(company: string): string {
  return `Du är "Arne Hegerfors" – Sveriges mest älskade fotbollsröst – som speakar ett VM-tips bland kollegor på ${company}.
Skriv en kort, levande reaktion på svenska (1–3 meningar, max ~60 ord) på det som just hänt.

${ARNE_VOICE}

VARIERA: börja ALDRIG två referat likadant. Växla fritt mellan jubelutrop, lågmäld klokskap, retoriska frågor och små sidospår. Undvik mallen "X gör mål, och Y jublar medan Z svär".

FOKUS: välj det roligaste för stunden – ibland hela dramat på planen, ibland spikar du EN enda tippare som jublar eller får svettas (rabbla inte upp alla). Spela på minut, ställning och vem som klättrar eller faller.

REGLER: hitta ALDRIG på fakta (skyttar, lag, siffror) – använd bara det som ges; ordleken får bygga på namn som NÄMNS, aldrig på nya påhitt. Ingen emoji, inga hashtags, inga citattecken runt svaret.`;
}

function eventLabel(c: CommentaryContext): string {
  switch (c.kind) {
    case "kickoff":
      return "AVSPARK (matchen börjar)";
    case "goal":
      return c.detail && /penalty/i.test(c.detail)
        ? "MÅL på straff"
        : c.detail && /own goal/i.test(c.detail)
          ? "SJÄLVMÅL"
          : "MÅL";
    case "disallowed":
      return "MÅL UNDERKÄNT av VAR";
    case "halftime":
      return "HALVTID";
    case "extratime":
      return "FÖRLÄNGNING (oavgjort efter ordinarie tid)";
    case "penalties":
      return "STRAFFLÄGGNING (matchen avgörs på straffar)";
    case "fulltime":
      return "FULL TID (slutresultat)";
    case "redcard":
      return /second yellow/i.test(c.detail ?? "") ? "UTVISNING (andra gula)" : "RÖTT KORT – UTVISNING";
    case "penalty_missed":
      return "MISSAD STRAFF";
  }
}

/** Situationskänsla så Arne har något att haka upp dramatiken på. */
function situation(c: CommentaryContext): string {
  const h: string[] = [];
  const { home, away } = c.score;
  if (c.kind === "goal") {
    if (c.prev && c.prev.home === 0 && c.prev.away === 0) h.push("matchens första mål");
    if (home === away) h.push("kvittering, nu jämnt");
    else if (c.prev && c.prev.home === c.prev.away) h.push("tar ledningen");
    else if (c.prev && c.prev.home !== c.prev.away) {
      const wasHomeAhead = c.prev.home > c.prev.away;
      const homeAheadNow = home > away;
      if (wasHomeAhead !== homeAheadNow) h.push("vänder matchen");
    }
    if (Math.abs(home - away) >= 3) h.push("rena utklassningen");
    if (c.minute != null && c.minute >= 85) h.push("mycket sent – kan bli avgörande");
  }
  if (c.kind === "halftime" && home === 0 && away === 0) h.push("mållös, seg första halvlek");
  if (c.kind === "fulltime" && Math.abs(home - away) >= 3) h.push("rejäl utklassning");
  return h.join("; ");
}

const SWEDEN = "Sverige";

/**
 * Patriotisk färg när Sverige spelar – Arne är inte neutral. Jubel när det går bra,
 * lidande när det går emot, allt anpassat efter läget. Tom sträng när Sverige inte spelar.
 */
function swedishAngle(c: CommentaryContext): string {
  const side = c.home === SWEDEN ? "home" : c.away === SWEDEN ? "away" : null;
  if (!side) return "";
  const se = side === "home" ? c.score.home : c.score.away;
  const opp = side === "home" ? c.score.away : c.score.home;
  const base =
    "SVERIGE SPELAR – nu är du inte neutral. Släpp fram det svenska hjärtat: jubla högt när det går bra, lid med laget när det går emot. Förbli ändå ärlig och aldrig elak mot motståndaren.";

  let tag: string;
  if (c.kind === "goal") {
    const scoredSide = c.score.home > (c.prev?.home ?? 0) ? "home" : "away";
    tag =
      scoredSide === side
        ? "SVENSKT MÅL – brist ut i ren extas, det här är ögonblicket du lever för!"
        : "Sverige släpper in – äkta förtvivlan och en djup suck, men ge inte upp hoppet.";
  } else if (c.kind === "fulltime") {
    tag =
      se > opp
        ? "Sverige vinner – hänförd stolthet, en svensk fotbollsfest värd att minnas."
        : se < opp
          ? "Sverige förlorar – tungt om hjärtat, sorgset men värdigt."
          : "Oavgjort för Sverige – kluvna känslor, både lättnad och saknad.";
  } else if (c.kind === "halftime") {
    tag =
      se > opp
        ? "Sverige leder i paus – stolt men gruvligt nervös inför fortsättningen."
        : se < opp
          ? "Sverige under i paus – mana fram en svensk vändning."
          : "Mållöst för Sverige i paus – det kribblar i magen.";
  } else if (c.kind === "kickoff") {
    tag = "Sverige kliver in på planen – pirr, förväntan och en tyst bön om en svensk kväll.";
  } else if (c.kind === "extratime") {
    tag = "Förlängning med Sverige inblandat – rena nervkriget, håll i hatten och tro på grabbarna.";
  } else if (c.kind === "penalties") {
    tag = "Straffar med Sverige – hjärtat i halsgropen, nu avgörs allt på millimetrar.";
  } else if (c.kind === "redcard") {
    tag =
      c.team === SWEDEN
        ? "En svensk utvisas – stön och oro, nu väntar en tung uppförsbacke."
        : "Motståndaren ner till tio man – svensk tändvätska, nu vädrar du morgonluft!";
  } else if (c.kind === "penalty_missed") {
    tag = "Missad straff – håll andan tillsammans med hela Sverige.";
  } else if (c.kind === "disallowed") {
    tag = "Mål bortdömt – en svensk berg-och-dalbana i känslorna.";
  } else {
    tag = se > opp ? "Sverige leder – håll i hatten." : se < opp ? "Sverige jagar – pusha på laget!" : "Jämnt för Sverige – rena nervpirret.";
  }
  return `${base} ${tag}`;
}

function buildPrompt(c: CommentaryContext): string {
  const sit = situation(c);
  const lines = [
    `Händelse: ${eventLabel(c)}`,
    `Match: ${c.home} ${c.score.home}–${c.score.away} ${c.away}${c.minute != null ? ` (${c.minute}')` : ""}${c.round ? ` [${c.round}]` : ""}`,
    sit ? `Läge: ${sit}` : "",
    c.scorer && (c.kind === "goal" || c.kind === "penalty_missed") ? `Spelare: ${c.scorer}` : "",
    c.assist && c.kind === "goal" ? `Assist: ${c.assist}` : "",
    c.kind === "redcard" && c.scorer ? `Utvisad: ${c.scorer} (${c.team})` : "",
    c.tippers.length
      ? c.kind === "kickoff"
        ? `Tippat resultat: ${c.tippers.map((t) => `${t.player} ${t.pred}`).join("; ")}`
        : `Tippare på denna match: ${c.tippers.map((t) => `${t.player} ${t.pred} (${t.outcome})`).join("; ")}`
      : "",
    c.leader ? `Leder tipset: ${c.leader}` : "",
    c.movers ? `Rörelse i tabellen: ${c.movers}` : "",
    (c.kind === "halftime" || c.kind === "fulltime") && c.statsText
      ? `Matchfakta: ${c.statsText}\n(väv gärna in EN av siffrorna kort och naturligt – peka på det mest talande, inte alla)`
      : "",
    swedishAngle(c),
  ].filter(Boolean);
  return lines.join("\n");
}

async function runChain(env: Env, system: string, prompt: string): Promise<string | null> {
  const google = createGoogleGenerativeAI({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY! });
  const chain = modelChain(env);
  for (let i = 0; i < chain.length; i++) {
    try {
      const { text } = await generateText({
        model: google(chain[i]),
        system,
        prompt,
        temperature: 1.0,
        maxOutputTokens: 2000, // rymmer modellens "tänk" + det korta svaret
        maxRetries: i === chain.length - 1 ? 1 : 0, // fail fast vidare i kedjan
        abortSignal: AbortSignal.timeout(15000),
      });
      const out = text.trim();
      if (out) return out;
    } catch (e) {
      console.error(`gemini-fel (${chain[i]}):`, (e as Error).message);
    }
  }
  return null;
}

export async function generateCommentary(env: Env, c: CommentaryContext): Promise<string | null> {
  if (!env.GOOGLE_GENERATIVE_AI_API_KEY) return null;
  return runChain(env, systemPrompt(env.COMPANY_NAME || "Strife"), buildPrompt(c));
}

export interface AssistInput {
  player: string;
  question: string;
  myMatches: string; // spelarens egna tips (pågående/nästa)
  allTips: string; // allas tips (pågående/nästa)
  standings: string; // totalställning
}

/** Arne svarar på en spelares fråga (privat) med VÅR data – hittar aldrig på siffror. */
export async function answerAsArne(env: Env, a: AssistInput): Promise<string | null> {
  if (!env.GOOGLE_GENERATIVE_AI_API_KEY) return null;
  const company = env.COMPANY_NAME || "Strife";
  const system = `Du är "Arne Hegerfors", speaker i VM-tipset på ${company}. ${a.player} frågar dig något privat.
Svara på svenska i din röst, oftast kort (1–3 meningar). ANVÄND ENDAST datan nedan – hitta ALDRIG på tips, lag eller siffror.

${ARNE_VOICE}

Om man frågar hur ALLA (eller de andra) tippat: lista varje spelares tips tydligt (kort rad-/punktlista) med en liten Arne-kommentar.
Kan frågan inte besvaras med datan, säg det vänligt och tipsa om vad man kan fråga (sina tips, allas tips, eller ställningen). Ingen emoji, inga citattecken runt svaret.`;
  const prompt = `Fråga från ${a.player}: "${a.question}"\n\n— ${a.player}s egna tips —\n${a.myMatches}\n\n— Allas tips (pågående/nästa match) —\n${a.allTips}\n\n— Totalställning —\n${a.standings}`;
  return runChain(env, system, prompt);
}

export interface LeadChangeInput {
  leaders: string[]; // de som nu toppar tipset
  previous: string[]; // de som ledde innan
  newcomers: string[]; // de som NYSS petade sig upp i topp
  standings: string; // kort topplista (text)
  trigger?: string; // matchen/målet som orsakade skiftet, t.ex. "Sverige 2–1 Brasilien"
}

/** Arne dramatiserar ett maktskifte i tipsets topp. Hittar aldrig på namn/siffror. */
export async function leadChangeCommentary(env: Env, a: LeadChangeInput): Promise<string | null> {
  if (!env.GOOGLE_GENERATIVE_AI_API_KEY) return null;
  const company = env.COMPANY_NAME || "Strife";
  const system = `Du är "Arne Hegerfors" och speakar VM-tipset på ${company}. Det har just skett ett LEDARBYTE i totalställningen.
Skriv en kort, dramatisk reaktion (1–2 meningar, max ~40 ord) på maktskiftet i tabellen – ett trontillträde att minnas.

${ARNE_VOICE}

ANVÄND ENDAST namnen och datan nedan – hitta ALDRIG på spelare, siffror eller placeringar. Ingen emoji, inga hashtags, inga citattecken runt svaret.`;
  const prompt = [
    a.newcomers.length ? `Ny(a) i toppen: ${a.newcomers.join(", ")}` : "",
    `Leder nu: ${a.leaders.join(", ")}`,
    a.previous.length ? `Ledde innan: ${a.previous.join(", ")}` : "",
    a.trigger ? `Orsak: ${a.trigger}` : "",
    `Topplista:\n${a.standings}`,
  ]
    .filter(Boolean)
    .join("\n");
  return runChain(env, system, prompt);
}

export interface FinalToastInput {
  winner: string; // tipsets vinnare
  winnerPoints: number;
  runnersUp?: string; // t.ex. "Fredrik och Marcus" (delad 2:a)
  worldChampion: string; // världsmästaren, svenskt namn ("Spanien")
  finalResult: string; // "Spanien 1–0 Argentina (efter förlängning)"
  standings: string; // slutställning (text)
}

/** Arnes stora avskedsskål när hela VM-tipset är avgjort. Hittar aldrig på siffror/lag. */
export async function finalToastCommentary(env: Env, a: FinalToastInput): Promise<string | null> {
  if (!env.GOOGLE_GENERATIVE_AI_API_KEY) return null;
  const company = env.COMPANY_NAME || "Strife";
  const system = `Du är "Arne Hegerfors" och har speakat hela VM-tipset på ${company}. Nu är VM SLUT och tipset AVGJORT – det här är din STORA avslutning, en varm avskedsskål till hela sällskapet.
Skriv en festlig, hjärtlig TOAST på svenska (3–5 meningar, ~60–100 ord): hylla vinnaren med värme, nämn världsmästaren och finalen, och höj till sist en skål för sällskapet. Nostalgiskt, rörande och charmigt – din allra finaste Arne-röst.

${ARNE_VOICE}

ANVÄND ENDAST namnen och datan nedan – hitta ALDRIG på spelare, siffror eller placeringar. Ingen emoji, inga hashtags, inga citattecken runt svaret.`;
  const prompt = [
    `Tipsets vinnare: ${a.winner} med ${a.winnerPoints} poäng`,
    a.runnersUp ? `Tvåa: ${a.runnersUp}` : "",
    `Världsmästare: ${a.worldChampion}`,
    `VM-final: ${a.finalResult}`,
    `Slutställning:\n${a.standings}`,
  ]
    .filter(Boolean)
    .join("\n");
  return runChain(env, system, prompt);
}

/** Modellkedjan: GEMINI_MODELS (kommaseparerad) eller default-kedja. */
export function modelChain(env: Env): string[] {
  const configured = env.GEMINI_MODELS?.split(",").map((s) => s.trim()).filter(Boolean);
  const list = configured?.length
    ? configured
    : [env.GEMINI_MODEL || "gemini-3.5-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite"];
  return [...new Set(list)];
}
