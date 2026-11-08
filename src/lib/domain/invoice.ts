import { D, dec, money, sum, ZERO, type Dec, type DecInput } from "./decimal";

export interface InvoiceLineInput {
  qty: DecInput;
  unitPrice: DecInput;
  /** Satır iskontosu (tutar). Oran verilmişse önce tutara çevrilir. */
  discountAmount?: DecInput | null;
  discountPct?: DecInput | null;
  /** Belgede yazan KDV hariç satır tutarı (UBL LineExtensionAmount). Varsa esas alınır. */
  docLineNet?: DecInput | null;
  vatRate: DecInput;
  /** Belgede yazan satır KDV tutarı (varsa esas alınır) */
  docVatAmount?: DecInput | null;
}

export interface InvoiceLine {
  grossBeforeDiscount: Dec;
  discountAmount: Dec;
  lineNet: Dec;
  vatRate: Dec;
  vatAmount: Dec;
}

/** Satır: KDV hariç net = miktar × birim fiyat − iskonto */
export function computeLine(l: InvoiceLineInput): InvoiceLine {
  const base = money(dec(l.qty).times(dec(l.unitPrice)));
  let disc = money(dec(l.discountAmount ?? 0));
  if ((l.discountAmount === null || l.discountAmount === undefined || dec(l.discountAmount).isZero()) && l.discountPct) {
    disc = money(base.times(dec(l.discountPct)).div(100));
  }
  const net = l.docLineNet !== null && l.docLineNet !== undefined && l.docLineNet !== "" ? money(l.docLineNet) : money(base.minus(disc));
  const vatAmount =
    l.docVatAmount !== null && l.docVatAmount !== undefined && l.docVatAmount !== ""
      ? money(l.docVatAmount)
      : money(net.times(dec(l.vatRate)).div(100));
  return { grossBeforeDiscount: base, discountAmount: disc, lineNet: net, vatRate: dec(l.vatRate), vatAmount };
}

/**
 * Belge geneli iskontoyu satırlara net tutarları oranında dağıtır.
 * Yuvarlama artığı en büyük satıra yazılır; dağıtılan toplam iskontoya tam eşittir.
 */
export function distributeDocDiscount(lineNets: DecInput[], docDiscount: DecInput): Dec[] {
  const nets = lineNets.map((x) => money(x));
  const total = sum(nets);
  const disc = money(docDiscount);
  if (disc.isZero() || total.isZero()) return nets.map(() => ZERO);
  const shares = nets.map((n) => money(disc.times(n).div(total)));
  const diff = disc.minus(sum(shares));
  if (!diff.isZero()) {
    let maxI = 0;
    nets.forEach((n, i) => {
      if (n.gt(nets[maxI]!)) maxI = i;
    });
    shares[maxI] = shares[maxI]!.plus(diff);
  }
  return shares;
}

export interface Totals {
  exclVat: Dec;
  vat: Dec;
  inclVat: Dec;
}

export function invoiceTotals(lines: Array<{ lineNet: DecInput; vatAmount: DecInput }>): Totals {
  const exclVat = money(sum(lines.map((l) => l.lineNet)));
  const vat = money(sum(lines.map((l) => l.vatAmount)));
  return { exclVat, vat, inclVat: money(exclVat.plus(vat)) };
}

export const TOTAL_TOLERANCE = new D("0.05");

/** Belge toplamları ile satırlardan hesaplanan toplamları karşılaştırır (0,05 TL tolerans). */
export function compareTotals(
  doc: Partial<Record<keyof Totals, DecInput | null>>,
  calc: Totals,
): { mismatch: boolean; diffs: Partial<Record<keyof Totals, Dec>> } {
  const diffs: Partial<Record<keyof Totals, Dec>> = {};
  let mismatch = false;
  (["exclVat", "vat", "inclVat"] as const).forEach((k) => {
    const v = doc[k];
    if (v === null || v === undefined || v === "") return;
    const diff = money(dec(v).minus(calc[k]));
    diffs[k] = diff;
    if (diff.abs().gt(TOTAL_TOLERANCE)) mismatch = true;
  });
  return { mismatch, diffs };
}
