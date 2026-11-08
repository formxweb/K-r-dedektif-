import "server-only";
import * as XLSX from "xlsx";
import Papa from "papaparse";

export type Cell = string | number | boolean | null;

export interface Sheet {
  name: string;
  rows: Cell[][];
}

export interface ReadResult {
  format: "xlsx" | "xls" | "csv";
  encoding: "utf-8" | "windows-1254" | null;
  sheets: Sheet[];
}

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ROWS = 50_000;

function detectEncoding(buf: Uint8Array): "utf-8" | "windows-1254" {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return "utf-8";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return "utf-8";
  } catch {
    return "windows-1254";
  }
}

export function decodeText(buf: Uint8Array, encoding?: "utf-8" | "windows-1254"): { text: string; encoding: "utf-8" | "windows-1254" } {
  const enc = encoding ?? detectEncoding(buf);
  let text = new TextDecoder(enc).decode(buf);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { text, encoding: enc };
}

function trimRows(rows: Cell[][]): Cell[][] {
  const out = rows.map((r) => {
    let end = r.length;
    while (end > 0 && (r[end - 1] === null || r[end - 1] === "")) end--;
    return r.slice(0, end);
  });
  let last = out.length;
  while (last > 0 && out[last - 1]!.length === 0) last--;
  return out.slice(0, last);
}

/**
 * .xls / .xlsx / .csv dosyasını satır dizisine çevirir.
 * Sayı hücreleri ham değer olarak gelir (Excel'in görüntü biçimi değil). Tarih hücreleri Excel seri numarasıdır.
 */
export function readTable(buf: Uint8Array, fileName: string, opts: { encoding?: "utf-8" | "windows-1254"; delimiter?: string } = {}): ReadResult {
  const lower = fileName.toLowerCase();
  if (buf.byteLength > MAX_FILE_BYTES) throw new Error("Dosya 10 MB'tan büyük. Raporu daha kısa bir tarih aralığıyla dışa aktarın.");
  if (lower.endsWith(".csv") || lower.endsWith(".txt")) {
    const { text, encoding } = decodeText(buf, opts.encoding);
    const parsed = Papa.parse<string[]>(text, { delimiter: opts.delimiter ?? "", skipEmptyLines: "greedy" });
    const rows = trimRows(parsed.data.map((r) => r.map((c) => (c === "" ? null : c))));
    if (rows.length > MAX_ROWS) throw new Error(`Dosyada ${rows.length} satır var; en fazla ${MAX_ROWS} satır işlenebilir.`);
    return { format: "csv", encoding, sheets: [{ name: "CSV", rows }] };
  }
  if (!lower.endsWith(".xlsx") && !lower.endsWith(".xls")) {
    throw new Error("Desteklenen dosya türleri: .xls, .xlsx, .csv");
  }
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buf, { type: "array", cellDates: false, cellNF: false, cellText: false, dense: true, codepage: 1254 });
  } catch {
    throw new Error("Excel dosyası açılamadı. Dosya bozuk veya parola korumalı olabilir.");
  }
  const sheets: Sheet[] = wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name]!;
    const rows = XLSX.utils.sheet_to_json<Cell[]>(ws, { header: 1, raw: true, defval: null, blankrows: true });
    return { name, rows: trimRows(rows) };
  }).filter((s) => s.rows.length > 0);
  const total = sheets.reduce((n, s) => n + s.rows.length, 0);
  if (total > MAX_ROWS) throw new Error(`Dosyada ${total} satır var; en fazla ${MAX_ROWS} satır işlenebilir.`);
  return { format: lower.endsWith(".xls") ? "xls" : "xlsx", encoding: null, sheets };
}
