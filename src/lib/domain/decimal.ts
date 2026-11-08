import Decimal from "decimal.js";

// Tek bir yapılandırılmış Decimal: tüm para/miktar hesapları bunu kullanır.
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof D>;
export type DecInput = Dec | string | number;

export const ZERO = new D(0);
export const ONE = new D(1);
export const HUNDRED = new D(100);

export function dec(v: DecInput | null | undefined): Dec {
  if (v === null || v === undefined || v === "") return ZERO;
  return v instanceof D ? v : new D(v);
}

export function decOrNull(v: DecInput | null | undefined): Dec | null {
  if (v === null || v === undefined || v === "") return null;
  return v instanceof D ? v : new D(v);
}

/** Para: 4 ondalık (veritabanı numeric(14,4)) */
export const money = (v: DecInput): Dec => dec(v).toDecimalPlaces(4, D.ROUND_HALF_UP);
/** Miktar: 3 ondalık (veritabanı numeric(14,3)) */
export const qty = (v: DecInput): Dec => dec(v).toDecimalPlaces(3, D.ROUND_HALF_UP);
/** Ekranda kuruş: 2 ondalık */
export const kurus = (v: DecInput): Dec => dec(v).toDecimalPlaces(2, D.ROUND_HALF_UP);

export function sum(values: Array<DecInput | null | undefined>): Dec {
  return values.reduce<Dec>((acc, v) => acc.plus(dec(v)), ZERO);
}

/** Yukarı doğru adıma yuvarlar (ör. 11,312 → 0,50 adımla 11,50). */
export function ceilToStep(v: DecInput, step: DecInput): Dec {
  const s = dec(step);
  if (s.lte(0)) return dec(v);
  return dec(v).div(s).toDecimalPlaces(0, D.ROUND_CEIL).times(s);
}
