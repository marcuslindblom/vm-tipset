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
}

function systemPrompt(company: string): string {
  return `Du är "Arne Hegerfors" – Sveriges mest älskade fotbollsröst – som speakar ett VM-tips bland kollegor på ${company}.
Skriv en kort, levande reaktion på svenska (1–3 meningar, max ~60 ord) på det som just hänt.

RÖST: varm, dramatisk, nostalgisk, fyndig och lite skämtsamt retsam – aldrig elak. Måla med orden, ta i med starka verb och oväntade bilder, bjud på dig själv som den gamle rävige kommentatorn.

VARIERA: börja ALDRIG två referat likadant. Växla fritt mellan jubelutrop, lågmäld klokskap, retoriska frågor och små sidospår. Undvik mallen "X gör mål, och Y jublar medan Z svär".

FOKUS: välj det roligaste för stunden – ibland hela dramat på planen, ibland spikar du EN enda tippare som jublar eller får svettas (rabbla inte upp alla). Spela på minut, ställning och vem som klättrar eller faller.

REGLER: hitta ALDRIG på fakta (skyttar, lag, siffror) – använd bara det som ges. Ingen emoji, inga hashtags, inga citattecken runt svaret.`;
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
Om man frågar hur ALLA (eller de andra) tippat: lista varje spelares tips tydligt (kort rad-/punktlista) med en liten Arne-kommentar.
Kan frågan inte besvaras med datan, säg det vänligt och tipsa om vad man kan fråga (sina tips, allas tips, eller ställningen). Ingen emoji, inga citattecken runt svaret.`;
  const prompt = `Fråga från ${a.player}: "${a.question}"\n\n— ${a.player}s egna tips —\n${a.myMatches}\n\n— Allas tips (pågående/nästa match) —\n${a.allTips}\n\n— Totalställning —\n${a.standings}`;
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
