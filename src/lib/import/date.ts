import { isIsoDate, istDayStartUtc } from "@/lib/domain/dates";

export type DateFormat = "DD.MM.YYYY" | "YYYY-MM-DD" | "MM/DD/YYYY";

export interface ParsedDate {
  date: string | null;
  /** saat varsa İstanbul saatine göre UTC ISO zaman damgası */
  timestamp: string | null;
  error?: string;
}

function pad(n: number | string): string {
  return String(n).padStart(2, "0");
}

/** Excel seri tarihi (1900 sistemi) → YYYY-MM-DD ve saniye */
function fromExcelSerial(serial: number): { date: string; seconds: number } {
  const whole = Math.floor(serial);
  const seconds = Math.round((serial - whole) * 86400);
  const ms = Date.UTC(1899, 11, 30) + whole * 86_400_000;
  return { date: new Date(ms).toISOString().slice(0, 10), seconds };
}

function withTime(date: string, h: number, m: number, s: number): string {
  const base = Date.parse(istDayStartUtc(date));
  return new Date(base + ((h * 60 + m) * 60 + s) * 1000).toISOString();
}

export function parseDateCell(input: unknown, format: DateFormat): ParsedDate {
  if (input === null || input === undefined || input === "") return { date: null, timestamp: null };
  if (typeof input === "number") {
    if (input < 20000 || input > 80000) return { date: null, timestamp: null, error: `"${input}" tarih olarak okunamadı` };
    const { date, seconds } = fromExcelSerial(input);
    const ts = seconds > 0 ? withTime(date, Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60) : null;
    return { date, timestamp: ts };
  }
  const s = String(input).trim();
  const time = s.match(/[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  const datePart = s.split(/[ T]/)[0]!;
  let y: string | undefined, m: string | undefined, d: string | undefined;
  const iso = datePart.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const dmy = datePart.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (iso) [, y, m, d] = iso;
  else if (dmy && format === "MM/DD/YYYY") [, m, d, y] = dmy;
  else if (dmy) [, d, m, y] = dmy;
  if (!y || !m || !d) return { date: null, timestamp: null, error: `"${s}" tarih olarak okunamadı (beklenen ${format})` };
  const date = `${y}-${pad(m)}-${pad(d)}`;
  if (!isIsoDate(date)) return { date: null, timestamp: null, error: `"${s}" geçerli bir tarih değil` };
  const timestamp = time ? withTime(date, Number(time[1]), Number(time[2]), Number(time[3] ?? 0)) : null;
  return { date, timestamp };
}
