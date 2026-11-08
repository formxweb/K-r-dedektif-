import { D, dec, money, qty, type Dec, type DecInput } from "./decimal";

export type BaseUnit = "adet" | "kg" | "lt";
export type UnitKind = "base" | "scaled" | "package" | "unknown";

export interface UnitInfo {
  kind: UnitKind;
  /** base/scaled için hangi temel birim */
  base: BaseUnit | null;
  /** scaled için temel birime çarpan (gram → kg: 0,001) */
  scale: Dec | null;
  /** ekranda gösterilecek ad */
  label: string;
}

// UBL-TR birim kodları (UN/ECE Rec. 20) ve yaygın Türkçe yazımlar
const TABLE: Record<string, Omit<UnitInfo, "scale"> & { scale?: string }> = {
  C62: { kind: "base", base: "adet", label: "Adet" },
  NIU: { kind: "base", base: "adet", label: "Adet" },
  H87: { kind: "base", base: "adet", label: "Adet" },
  EA: { kind: "base", base: "adet", label: "Adet" },
  ADET: { kind: "base", base: "adet", label: "Adet" },
  AD: { kind: "base", base: "adet", label: "Adet" },
  KGM: { kind: "base", base: "kg", label: "Kg" },
  KG: { kind: "base", base: "kg", label: "Kg" },
  KILO: { kind: "base", base: "kg", label: "Kg" },
  GRM: { kind: "scaled", base: "kg", scale: "0.001", label: "Gram" },
  GR: { kind: "scaled", base: "kg", scale: "0.001", label: "Gram" },
  GRAM: { kind: "scaled", base: "kg", scale: "0.001", label: "Gram" },
  LTR: { kind: "base", base: "lt", label: "Litre" },
  LT: { kind: "base", base: "lt", label: "Litre" },
  LITRE: { kind: "base", base: "lt", label: "Litre" },
  MLT: { kind: "scaled", base: "lt", scale: "0.001", label: "Mililitre" },
  ML: { kind: "scaled", base: "lt", scale: "0.001", label: "Mililitre" },
  BX: { kind: "package", base: null, label: "Kutu" },
  KUTU: { kind: "package", base: null, label: "Kutu" },
  PA: { kind: "package", base: null, label: "Paket" },
  PK: { kind: "package", base: null, label: "Paket" },
  PAKET: { kind: "package", base: null, label: "Paket" },
  CT: { kind: "package", base: null, label: "Koli" },
  CS: { kind: "package", base: null, label: "Kasa" },
  CR: { kind: "package", base: null, label: "Kasa" },
  KOLI: { kind: "package", base: null, label: "Koli" },
  KOLİ: { kind: "package", base: null, label: "Koli" },
  KASA: { kind: "package", base: null, label: "Kasa" },
  SET: { kind: "package", base: null, label: "Set" },
  DZN: { kind: "package", base: null, label: "Düzine" },
};

export function resolveUnit(codeOrName: string | null | undefined): UnitInfo {
  const raw = (codeOrName ?? "").trim();
  if (!raw) return { kind: "unknown", base: null, scale: null, label: "" };
  const key = raw.toLocaleUpperCase("tr-TR").replace(/[^A-ZÇĞİÖŞÜ0-9]/g, "");
  const hit = TABLE[key];
  if (!hit) return { kind: "unknown", base: null, scale: null, label: raw };
  return { kind: hit.kind, base: hit.base, scale: hit.scale ? new D(hit.scale) : null, label: hit.label };
}

/**
 * Fatura birimi → ürünün temel birimine katsayı.
 * Tanımlı dönüşüm yoksa null döner: aktarım o satırda durur ve kullanıcıya sorar.
 */
export function unitFactor(
  unit: UnitInfo,
  productBase: BaseUnit,
  definedUnits: Array<{ name: string; factor: DecInput }> = [],
): Dec | null {
  if (unit.kind === "base" && (unit.base === null || unit.base === productBase)) return new D(1);
  if (unit.kind === "scaled" && unit.base === productBase && unit.scale) return unit.scale;
  const name = unit.label.toLocaleLowerCase("tr-TR");
  const hit = definedUnits.find((u) => u.name.toLocaleLowerCase("tr-TR") === name);
  return hit ? dec(hit.factor) : null;
}

/** Fatura miktarını temel birime çevirir: 2 koli × 24 = 48 adet */
export function toBaseQty(invoiceQty: DecInput, factor: DecInput): Dec {
  const f = dec(factor);
  if (f.lte(0)) throw new Error("Birim katsayısı sıfırdan büyük olmalı");
  return qty(dec(invoiceQty).times(f));
}

/** Temel birim başına maliyet (KDV hariç, iskontolar düşülmüş) */
export function unitCost(lineNet: DecInput, baseQty: DecInput): Dec {
  const q = dec(baseQty);
  if (q.lte(0)) throw new Error("Miktar sıfırdan büyük olmalı");
  return money(dec(lineNet).div(q));
}
