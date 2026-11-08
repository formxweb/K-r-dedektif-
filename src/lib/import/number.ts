import { D, type Dec } from "@/lib/domain/decimal";

export type DecimalSeparator = "," | ".";

export interface ParsedNumber {
  value: Dec | null;
  error?: string;
}

/**
 * Yerel biçimli sayıyı float kullanmadan çözer.
 *   "12.450,75" (sep ",") → 12450.75   "12,450.75" (sep ".") → 12450.75
 *   "1,5" → 1.5   "-3" / "3-" / "(3)" → -3   "₺ 12,00" / "12,00 TL" → 12
 * Excel'den gelen sayı hücreleri (JS number) en kısa ondalık gösterimiyle alınır.
 */
export function parseLocaleNumber(input: unknown, sep: DecimalSeparator): ParsedNumber {
  if (input === null || input === undefined) return { value: null };
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return { value: null, error: "Geçersiz sayı" };
    return { value: new D(String(input)) };
  }
  let s = String(input).trim();
  if (s === "" || s === "-") return { value: null };
  s = s.replace(/[\s  ]/g, "").replace(/₺|TL|TRY/gi, "").replace(/^%|%$/g, "");
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.endsWith("-")) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  const thousands = sep === "," ? "." : ",";
  if (s.includes(thousands)) {
    const parts = s.split(sep);
    if (parts.length > 2) return { value: null, error: `"${input}" sayı olarak okunamadı` };
    const intPart = parts[0]!;
    if (!/^\d{1,3}([.,]\d{3})*$/.test(intPart) || intPart.split(thousands).some((g, i) => i > 0 && g.length !== 3)) {
      return { value: null, error: `"${input}" sayı olarak okunamadı (ondalık ayracı "${sep}" seçili)` };
    }
    s = intPart.split(thousands).join("") + (parts.length === 2 ? "." + parts[1] : "");
  } else if (sep === ",") {
    s = s.replace(",", ".");
  }
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return { value: null, error: `"${input}" sayı olarak okunamadı` };
  if (s.endsWith(".")) s = s.slice(0, -1);
  const v = new D(s);
  return { value: negative ? v.neg() : v };
}

/**
 * Bir sütundaki örneklerden ondalık ayracını tahmin eder. Belirsizse null döner (kullanıcıya sorulur).
 */
export function detectDecimalSeparator(samples: unknown[]): DecimalSeparator | null {
  let comma = 0;
  let dot = 0;
  for (const raw of samples) {
    if (typeof raw !== "string") continue;
    const s = raw.trim();
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");
    if (lastComma >= 0 && lastDot >= 0) {
      if (lastComma > lastDot) comma++;
      else dot++;
    } else if (lastComma >= 0) {
      // "1,5" veya "12,00" → ondalık virgül; "1,234" belirsiz
      if (!/^\d{1,3}(,\d{3})+$/.test(s)) comma++;
    } else if (lastDot >= 0) {
      if (!/^\d{1,3}(\.\d{3})+$/.test(s)) dot++;
    }
  }
  if (comma === 0 && dot === 0) return null;
  if (comma > 0 && dot > 0) return comma > dot * 3 ? "," : dot > comma * 3 ? "." : null;
  return comma > 0 ? "," : ".";
}
