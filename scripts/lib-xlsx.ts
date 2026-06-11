// Minimal xlsx-läsare (endast för importskripten, körs i Node).
// En .xlsx är en zip med XML – vi packar upp med fflate och skannar cellerna med regex.

import { unzipSync, strFromU8 } from "fflate";
import { readFileSync } from "node:fs";

export type Grid = Map<string, string>; // "A13" -> värde

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const texts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unescapeXml(t[1]));
    out.push(texts.join(""));
  }
  return out;
}

function parseSheet(xml: string, shared: string[]): Grid {
  const grid: Grid = new Map();
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = m[1];
    const inner = m[2];
    if (inner === undefined) continue; // tom självstängande cell
    const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
    if (!ref) continue;
    const t = /t="([^"]+)"/.exec(attrs)?.[1];
    let val = "";
    if (t === "s") {
      const vi = /<v>(\d+)<\/v>/.exec(inner)?.[1];
      if (vi != null) val = shared[Number(vi)] ?? "";
    } else if (t === "inlineStr") {
      val = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => unescapeXml(x[1])).join("");
    } else {
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      if (v != null) val = unescapeXml(v);
    }
    if (val !== "") grid.set(ref, val);
  }
  return grid;
}

export function readWorkbook(path: string): Record<string, Grid> {
  const files = unzipSync(new Uint8Array(readFileSync(path)));
  const dec = (name: string) => (files[name] ? strFromU8(files[name]) : "");
  const shared = files["xl/sharedStrings.xml"]
    ? parseSharedStrings(dec("xl/sharedStrings.xml"))
    : [];

  const wb = dec("xl/workbook.xml");
  const nameToRid: { name: string; rid: string }[] = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*?\/?>/g)) {
    const name = /name="([^"]+)"/.exec(m[0])?.[1];
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1];
    if (name && rid) nameToRid.push({ name: unescapeXml(name), rid });
  }
  const rels = dec("xl/_rels/workbook.xml.rels");
  const ridToTarget = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*?\/?>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1];
    const target = /Target="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) ridToTarget.set(id, target);
  }

  const out: Record<string, Grid> = {};
  for (const { name, rid } of nameToRid) {
    let target = ridToTarget.get(rid);
    if (!target) continue;
    target = target.replace(/^\//, ""); // "/xl/worksheets/sheet1.xml" -> "xl/worksheets/sheet1.xml"
    if (!target.startsWith("xl/")) target = "xl/" + target;
    out[name] = parseSheet(dec(target), shared);
  }
  return out;
}

// ── rutnätshjälpare ───────────────────────────────────────────────────────────

export function colToNum(col: string): number {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
export function numToCol(n: number): string {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
export function splitRef(ref: string): { col: string; row: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
  return { col: m[1], row: Number(m[2]) };
}

/** Hitta första cellen vars värde matchar `re`; returnera dess ref + värde. */
export function findCell(grid: Grid, re: RegExp): { ref: string; value: string } | null {
  for (const [ref, value] of grid) if (re.test(value)) return { ref, value };
  return null;
}

/** Närmaste icke-tomma cell till höger på samma rad (för "label : värde"-mönster). */
export function valueRightOf(grid: Grid, ref: string, maxCols = 12): string | undefined {
  const { col, row } = splitRef(ref);
  const start = colToNum(col);
  for (let c = start + 1; c <= start + maxCols; c++) {
    const v = grid.get(`${numToCol(c)}${row}`);
    if (v != null && v !== "") return v;
  }
  return undefined;
}
