// Tarih yardımcıları. Tarihler "YYYY-MM-DD" metni olarak taşınır; gün sayıları tamsayıdır.

const DAY_MS = 86_400_000;

function toEpochDay(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Math.round(Date.UTC(y!, m! - 1, d!) / DAY_MS);
}

function fromEpochDay(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(iso: string, n: number): string {
  return fromEpochDay(toEpochDay(iso) + n);
}

/** b − a (gün) */
export function daysBetween(a: string, b: string): number {
  return toEpochDay(b) - toEpochDay(a);
}

export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return fromEpochDay(toEpochDay(s)) === s;
}

/** İstanbul saatine göre bugünün tarihi */
export function istToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return parts; // en-CA → YYYY-MM-DD
}

export function monthStart(iso: string): string {
  return iso.slice(0, 7) + "-01";
}

export function monthEnd(iso: string): string {
  const [y, m] = iso.slice(0, 7).split("-").map(Number);
  const next = m === 12 ? `${y! + 1}-01-01` : `${y}-${String(m! + 1).padStart(2, "0")}-01`;
  return addDays(next, -1);
}

export function addMonths(iso: string, n: number): string {
  const [y, m] = iso.slice(0, 7).split("-").map(Number);
  const total = y! * 12 + (m! - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-01`;
}

/** İstanbul saatinde bir günün başlangıcı (UTC ISO) — İstanbul 2016'dan beri sabit UTC+3 */
export function istDayStartUtc(iso: string): string {
  return new Date(toEpochDay(iso) * DAY_MS - 3 * 3_600_000).toISOString();
}
