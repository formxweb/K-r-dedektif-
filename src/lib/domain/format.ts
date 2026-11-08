import { D, dec, type DecInput } from "./decimal";

function groupThousands(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** Türkçe sayı biçimi, float kullanmadan: 12450.756 → "12.450,76" */
export function formatNumber(v: DecInput | null | undefined, decimals = 2): string {
  if (v === null || v === undefined || v === "") return "—";
  const d = dec(v).toDecimalPlaces(decimals, D.ROUND_HALF_UP);
  const neg = d.isNegative() && !d.isZero();
  const [i, f] = d.abs().toFixed(decimals).split(".");
  const body = groupThousands(i ?? "0") + (decimals > 0 ? "," + (f ?? "") : "");
  return neg ? "−" + body : body;
}

/** 12450.75 → "12.450,75 ₺" */
export function formatTL(v: DecInput | null | undefined, decimals = 2): string {
  if (v === null || v === undefined || v === "") return "—";
  return formatNumber(v, decimals) + " ₺";
}

/** Miktar: tam sayıysa ondalıksız, değilse en fazla 3 hane */
export function formatQty(v: DecInput | null | undefined, unit?: string): string {
  if (v === null || v === undefined || v === "") return "—";
  const d = dec(v);
  const decimals = d.isInteger() ? 0 : Math.min(3, d.decimalPlaces());
  return formatNumber(d, decimals) + (unit ? " " + unit : "");
}

/** Yüzde: 12.5 → "%12,5" */
export function formatPct(v: DecInput | null | undefined, decimals = 1): string {
  if (v === null || v === undefined || v === "") return "—";
  const d = dec(v);
  const s = formatNumber(d.abs(), decimals);
  return (d.isNegative() && !d.isZero() ? "−" : "") + "%" + s;
}

/** İşaretli değişim: +%10,0 / −%4,2 */
export function formatSignedPct(v: DecInput | null | undefined, decimals = 1): string {
  if (v === null || v === undefined || v === "") return "—";
  const d = dec(v);
  if (d.isZero()) return "%0";
  return (d.isNegative() ? "−" : "+") + "%" + formatNumber(d.abs(), decimals);
}

const MONTHS = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];

/** "2026-11-08" → "8 Kasım 2026" */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** "2026-11-08" → "08.11.2026" */
export function formatDateShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

/** "2026-11-01" → "Kasım 2026" */
export function formatMonth(iso: string): string {
  const [y, m] = iso.slice(0, 7).split("-");
  return `${MONTHS[Number(m) - 1]} ${y}`;
}

export const UNIT_LABEL: Record<string, string> = { adet: "adet", kg: "kg", lt: "lt" };
