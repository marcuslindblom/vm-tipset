// Laddar den genererade tipsdatan (src/data/predictions.json) och bygger
// uppslagsstrukturer som rättningsmotorn använder. Importeras av både Worker och skript.

import raw from "./data/predictions.json";
import type { Prediction } from "./scoring";
import type { LiveMatch } from "./types";
import { teamMatchKey, canonicalizeEnglish, toSwedish } from "./teams";

export interface FixtureInfo {
  home: string;
  away: string;
  homeSv: string;
  awaySv: string;
  group: string;
  excelDate: string;
  fixtureId: number | null;
}

export interface PredictionsData {
  keyBy: "fixtureId" | "teams";
  players: string[];
  kickoffs: string[]; // ISO UTC, alla avsparkstider (grupp + slutspel)
  fixtures: Record<string, FixtureInfo>;
  groupPredictions: Record<string, Record<string, [number, number]>>;
  knockout: Record<string, unknown>;
}

const data = raw as unknown as PredictionsData;

export const players: string[] = data.players;
export const keyBy = data.keyBy;
export const fixtures = data.fixtures;
export const kickoffs: string[] = data.kickoffs ?? [];

/** matchnyckel -> spelare -> tippat resultat. */
export function predictionsByMatch(): Map<string, Map<string, Prediction>> {
  const m = new Map<string, Map<string, Prediction>>();
  for (const [key, byPlayer] of Object.entries(data.groupPredictions)) {
    const inner = new Map<string, Prediction>();
    for (const [player, [h, a]] of Object.entries(byPlayer)) inner.set(player, { home: h, away: a });
    m.set(key, inner);
  }
  return m;
}

/** Samma nyckel som importen använde, härledd från en live-match. */
export function keyOfLive(m: LiveMatch): string {
  return keyBy === "fixtureId"
    ? String(m.fixtureId)
    : teamMatchKey(canonicalizeEnglish(m.home.name), canonicalizeEnglish(m.away.name));
}

/** Svenska visningsnamn för en match (från tipsdatan, annars översatt API-namn). */
export function displayNames(key: string, m?: LiveMatch): { home: string; away: string } {
  const f = fixtures[key];
  if (f) return { home: f.homeSv, away: f.awaySv };
  if (m) return { home: toSwedish(m.home.name), away: toSwedish(m.away.name) };
  return { home: key, away: "" };
}
