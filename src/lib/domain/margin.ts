import { ceilToStep, dec, D, type Dec, type DecInput } from "./decimal";

/** KDV dahil raf fiyatından KDV hariç satış fiyatı */
export function netSalePrice(saleGross: DecInput, vatRatePct: DecInput): Dec {
  return dec(saleGross).div(dec(vatRatePct).div(100).plus(1));
}

/** Kâr marjı (satış fiyatı üzerinden): (net satış − maliyet) / net satış × 100 */
export function marginPct(saleGross: DecInput, vatRatePct: DecInput, unitCost: DecInput): Dec | null {
  const net = netSalePrice(saleGross, vatRatePct);
  if (net.lte(0)) return null;
  return net.minus(dec(unitCost)).div(net).times(100);
}

/** Maliyet üstü kâr oranı: (net satış − maliyet) / maliyet × 100 */
export function markupPct(saleGross: DecInput, vatRatePct: DecInput, unitCost: DecInput): Dec | null {
  const c = dec(unitCost);
  if (c.lte(0)) return null;
  return netSalePrice(saleGross, vatRatePct).minus(c).div(c).times(100);
}

/**
 * Alış fiyatı arttığında eski marj oranını korumak için önerilen raf fiyatı:
 * yeni fiyat = mevcut fiyat × yeni maliyet / eski maliyet, adıma yukarı yuvarlanır.
 * Veritabanındaki uyarı hesabıyla aynı formül.
 */
export function suggestedPriceKeepingMargin(
  saleGross: DecInput,
  prevCost: DecInput,
  newCost: DecInput,
  step: DecInput,
): Dec | null {
  const p = dec(prevCost);
  if (p.lte(0)) return null;
  return ceilToStep(dec(saleGross).times(dec(newCost)).div(p), step);
}

/** Hedef marj için raf fiyatı (KDV dahil, adıma yukarı yuvarlanmış) */
export function priceForTargetMargin(unitCost: DecInput, targetMarginPct: DecInput, vatRatePct: DecInput, step: DecInput): Dec | null {
  const m = dec(targetMarginPct).div(100);
  if (m.gte(1) || m.isNegative()) return null;
  const net = dec(unitCost).div(new D(1).minus(m));
  return ceilToStep(net.times(dec(vatRatePct).div(100).plus(1)), step);
}
