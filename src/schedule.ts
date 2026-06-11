// Schemastyrning: avgör utifrån avsparkstiderna (från Excel) om någon match pågår
// just nu, så att Workern bara pollar under matchfönster och sover däremellan.

export interface ScheduleState {
  anyLive: boolean; // är vi inom någon matchs fönster just nu?
  nextKickoffMs: number | null; // nästa avspark i framtiden (för att sova fram till den)
}

/**
 * @param kickoffsMs  avsparkstider i epoch-ms
 * @param nowMs       nu i epoch-ms
 * @param windowMs    hur länge efter avspark en match anses pågå (täcker tillägg/förlängning)
 * @param leadMs      hur långt före avspark vi börjar polla
 */
export function scheduleState(
  kickoffsMs: number[],
  nowMs: number,
  windowMs: number,
  leadMs: number,
): ScheduleState {
  let anyLive = false;
  let next: number | null = null;
  for (const k of kickoffsMs) {
    if (nowMs >= k - leadMs && nowMs <= k + windowMs) anyLive = true;
    if (k > nowMs && (next === null || k < next)) next = k;
  }
  return { anyLive, nextKickoffMs: next };
}

/** Tolka ISO-strängar till sorterade epoch-ms (ogiltiga hoppas över). */
export function toKickoffMs(isoList: string[]): number[] {
  return isoList
    .map((s) => Date.parse(s))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);
}
