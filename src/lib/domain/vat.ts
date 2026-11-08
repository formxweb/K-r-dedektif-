import { D, dec, money, type Dec, type DecInput } from "./decimal";

/**
 * KDV dahil tutarı KDV hariç ve KDV'ye ayırır.
 * net = yuvarla4(brüt / (1 + oran/100)), kdv = brüt − net → net + kdv her zaman brüte eşittir.
 */
export function splitGross(gross: DecInput, ratePct: DecInput): { net: Dec; vat: Dec } {
  const g = dec(gross);
  const r = dec(ratePct);
  if (r.isNegative()) throw new Error("KDV oranı negatif olamaz");
  const net = money(g.div(r.div(100).plus(1)));
  return { net, vat: money(g.minus(net)) };
}

/** KDV hariç tutara KDV ekler: kdv = yuvarla4(net × oran/100) */
export function addVat(net: DecInput, ratePct: DecInput): { gross: Dec; vat: Dec } {
  const n = dec(net);
  const vat = money(n.times(dec(ratePct)).div(100));
  return { gross: money(n.plus(vat)), vat };
}

/** Fiyat alanını profil ayarına göre KDV hariçe çevirir. */
export function toNet(amount: DecInput, ratePct: DecInput, vatIncluded: boolean): { net: Dec; vat: Dec; gross: Dec } {
  if (vatIncluded) {
    const { net, vat } = splitGross(amount, ratePct);
    return { net, vat, gross: money(amount) };
  }
  const { gross, vat } = addVat(amount, ratePct);
  return { net: money(amount), vat, gross };
}

export function isValidVatRate(r: DecInput): boolean {
  const d = dec(r);
  return d.gte(0) && d.lt(100);
}

export { D };
