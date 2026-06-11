// AI-referat via Gemini (Vercel AI SDK). Genererar en kort, varierad reaktion i
// "Arne Hegerfors"-röst på matchhändelser – och retar tipparna utifrån deras tips.
// Utan API-nyckel (eller vid fel/timeout) returneras null => vanligt meddelande postas.

import { generateText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { Env } from "./types";
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
  score: { home: number; away: number };
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
  return `Du är "Arne Hegerfors", legendarisk svensk fotbollskommentator, nu speaker i ett VM-tipsspel bland kollegor på ${company}.
Skriv EN kort reaktion (1–2 meningar, max ~45 ord) på svenska om händelsen.
Kommentera både det som händer på planen OCH tipparna: vem jublar, vem svär, vem klättrar eller faller i tabellen.
Ton: dramatisk, varm, nostalgisk och lite retsam – aldrig elak. Variera dig, undvik klyschor du redan använt.
Hitta ALDRIG på fakta (skyttar, lag, siffror) – använd bara det som ges. Ingen emoji, inga hashtags, inga citattecken runt svaret.`;
}

function eventLabel(c: CommentaryContext): string {
  switch (c.kind) {
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

function buildPrompt(c: CommentaryContext): string {
  const lines = [
    `Händelse: ${eventLabel(c)}`,
    `Match: ${c.home} ${c.score.home}–${c.score.away} ${c.away}${c.minute != null ? ` (${c.minute}')` : ""}${c.round ? ` [${c.round}]` : ""}`,
    c.scorer && (c.kind === "goal" || c.kind === "penalty_missed") ? `Spelare: ${c.scorer}` : "",
    c.assist && c.kind === "goal" ? `Assist: ${c.assist}` : "",
    c.kind === "redcard" && c.scorer ? `Utvisad: ${c.scorer} (${c.team})` : "",
    c.tippers.length
      ? `Tippare på denna match: ${c.tippers.map((t) => `${t.player} tippade ${t.pred} (${t.outcome})`).join("; ")}`
      : "",
    c.leader ? `Leder tipset just nu: ${c.leader}` : "",
    c.movers ? `Rörelse i tabellen: ${c.movers}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

export async function generateCommentary(env: Env, c: CommentaryContext): Promise<string | null> {
  if (!env.GOOGLE_GENERATIVE_AI_API_KEY) return null;
  const google = createGoogleGenerativeAI({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY });
  const prompt = buildPrompt(c);

  // Primär modell (kvalitet); faller tillbaka till en annan vid t.ex. rate limit
  // (free-tier-kvoten är per modell, så fallback-modellen har en egen budget).
  const primary = env.GEMINI_MODEL || "gemini-3.5-flash";
  const fallback = env.GEMINI_FALLBACK_MODEL || "gemini-2.0-flash";
  const models = fallback && fallback !== primary ? [primary, fallback] : [primary];

  for (let i = 0; i < models.length; i++) {
    try {
      const { text } = await generateText({
        model: google(models[i]),
        system: systemPrompt(env.COMPANY_NAME || "Strife"),
        prompt,
        temperature: 1.0,
        maxOutputTokens: 2000, // rymmer modellens "tänk" + det korta svaret
        maxRetries: i === models.length - 1 ? 1 : 0, // fail fast till fallback
        abortSignal: AbortSignal.timeout(15000),
      });
      const out = text.trim();
      if (out) return out;
    } catch (e) {
      console.error(`kommentar-fel (${models[i]}):`, (e as Error).message);
    }
  }
  return null;
}
