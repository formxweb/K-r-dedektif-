import { XMLParser } from "fast-xml-parser";
import { dec, money, qty as qty3, sum, ZERO, type Dec } from "@/lib/domain/decimal";
import { compareTotals, distributeDocDiscount, invoiceTotals } from "@/lib/domain/invoice";
import { resolveUnit } from "@/lib/domain/units";
import { isIsoDate } from "@/lib/domain/dates";
import type { StageLine } from "./transform";

/**
 * e-Fatura / e-Arşiv (UBL-TR 1.2) XML ayrıştırıcı.
 * Gerekli alanlar: fatura no, ETTN, tarih, tedarikçi (VKN/TCKN, ad), satırlar, toplamlar.
 */

export interface UblHeader {
  invoice_no: string;
  ettn: string | null;
  invoice_date: string;
  invoice_type: string | null;
  profile: string | null;
  supplier_name: string | null;
  supplier_tax_number: string | null;
  doc_total_excl_vat: string | null;
  doc_total_vat: string | null;
  doc_total_incl_vat: string | null;
  calc_total_excl_vat: string;
  calc_total_vat: string;
  calc_total_incl_vat: string;
  total_mismatch: boolean;
}

export interface UblInvoice {
  header: UblHeader;
  lines: StageLine[];
  warnings: string[];
}

export class UblError extends Error {}

type Node = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  isArray: (name) => ["InvoiceLine", "AllowanceCharge", "TaxSubtotal", "PartyIdentification", "Invoice"].includes(name),
});

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (typeof v === "object" && "#text" in (v as Node)) return text((v as Node)["#text"]);
  return null;
}

function attr(v: unknown, name: string): string | null {
  if (v && typeof v === "object") return text((v as Node)[`@_${name}`]);
  return null;
}

function obj(v: unknown): Node {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Node) : {};
}

function arr(v: unknown): Node[] {
  if (Array.isArray(v)) return v.map(obj);
  return v ? [obj(v)] : [];
}

function num(v: unknown): Dec | null {
  const t = text(v);
  if (t === null) return null;
  if (!/^-?\d+(\.\d+)?$/.test(t)) throw new UblError(`Faturadaki "${t}" değeri sayı değil.`);
  return dec(t);
}

function findInvoice(root: Node): Node | null {
  if (Array.isArray(root.Invoice) && root.Invoice.length > 0) return obj(root.Invoice[0]);
  for (const v of Object.values(root)) {
    if (v && typeof v === "object") {
      const found = Array.isArray(v) ? v.map((x) => (x && typeof x === "object" ? findInvoice(x as Node) : null)).find(Boolean) : findInvoice(v as Node);
      if (found) return found;
    }
  }
  return null;
}

const BARCODE_RE = /^(\d{8}|\d{12,14})$/;

function lineVat(line: Node): { rate: Dec; amount: Dec; otherTaxes: Dec } {
  const tt = obj(line.TaxTotal);
  const subs = arr(tt.TaxSubtotal);
  let rate: Dec | null = null;
  let amount: Dec | null = null;
  let other = ZERO;
  for (const s of subs) {
    const code = text(obj(obj(s.TaxCategory).TaxScheme).TaxTypeCode);
    const pct = num(s.Percent);
    const amt = num(s.TaxAmount) ?? ZERO;
    if (code === null || code === "0015") {
      rate = pct ?? rate;
      amount = (amount ?? ZERO).plus(amt);
    } else {
      other = other.plus(amt);
    }
  }
  if (rate === null) {
    // Bazı faturalarda alt kırılım yok: toplam KDV / satır tutarı
    const total = num(tt.TaxAmount);
    const ext = num(line.LineExtensionAmount);
    if (total && ext && ext.gt(0)) rate = total.div(ext).times(100).toDecimalPlaces(0);
    amount = total;
  }
  return { rate: rate ?? ZERO, amount: amount ?? ZERO, otherTaxes: other };
}

/**
 * Belge iskontosunu satırlara dağıtır. Faturanın KDV alt kırılımları (oran başına matrah) varsa
 * her oran grubuna kendi indirimi verilir — böylece KDV tutarları belgeyle aynı kalır.
 * Yoksa tüm satırlara tutarları oranında dağıtılır.
 */
function allocateDocDiscount(inv: Node, lines: Array<{ ext: Dec; vatRate: Dec }>, docDiscount: Dec): Dec[] {
  if (docDiscount.isZero()) return lines.map(() => ZERO);
  const tax = obj(Array.isArray(inv.TaxTotal) ? inv.TaxTotal[0] : inv.TaxTotal);
  const taxable = new Map<string, Dec>();
  for (const st of arr(tax.TaxSubtotal)) {
    const code = text(obj(obj(st.TaxCategory).TaxScheme).TaxTypeCode);
    if (code !== null && code !== "0015") continue;
    const pct = num(st.Percent);
    const base = num(st.TaxableAmount);
    if (pct === null || base === null) continue;
    const k = pct.toString();
    taxable.set(k, (taxable.get(k) ?? ZERO).plus(base));
  }
  const groups = new Map<string, number[]>();
  lines.forEach((l, i) => groups.set(l.vatRate.toString(), [...(groups.get(l.vatRate.toString()) ?? []), i]));
  if (taxable.size > 0 && [...groups.keys()].every((k) => taxable.has(k))) {
    const groupDisc = new Map<string, Dec>();
    for (const [k, idx] of groups) groupDisc.set(k, money(sum(idx.map((i) => lines[i]!.ext)).minus(taxable.get(k)!)));
    if (sum([...groupDisc.values()]).minus(docDiscount).abs().lte("0.05")) {
      const out = lines.map(() => ZERO);
      for (const [k, idx] of groups) {
        const part = distributeDocDiscount(idx.map((i) => lines[i]!.ext), groupDisc.get(k)!);
        idx.forEach((i, j) => (out[i] = part[j]!));
      }
      return out;
    }
  }
  return distributeDocDiscount(lines.map((l) => l.ext), docDiscount);
}

export function parseUblInvoice(xml: string): UblInvoice {
  let root: Node;
  try {
    root = parser.parse(xml) as Node;
  } catch {
    throw new UblError("XML dosyası okunamadı. Dosya bozuk olabilir.");
  }
  const inv = findInvoice(root);
  if (!inv) throw new UblError("Bu XML bir e-Fatura (UBL Invoice) değil.");
  const warnings: string[] = [];

  const invoiceNo = text(inv.ID);
  const date = text(inv.IssueDate);
  if (!invoiceNo) throw new UblError("Faturada fatura numarası (ID) yok.");
  if (!date || !isIsoDate(date)) throw new UblError("Faturada geçerli bir tarih (IssueDate) yok.");
  const type = text(inv.InvoiceTypeCode);
  if (type === "IADE") throw new UblError("İade faturaları bu sürümde desteklenmiyor. İadeyi ürün ekranından 'tedarikçiye iade' olarak girin.");
  const currency = text(inv.DocumentCurrencyCode) ?? "TRY";
  if (currency !== "TRY") throw new UblError(`Döviz cinsinden fatura (${currency}) bu sürümde desteklenmiyor.`);

  const party = obj(obj(inv.AccountingSupplierParty).Party);
  let taxNo: string | null = null;
  for (const pid of arr(party.PartyIdentification)) {
    const scheme = attr(pid.ID, "schemeID");
    if (scheme === "VKN" || scheme === "TCKN") taxNo = text(pid.ID);
  }
  const person = obj(party.Person);
  const supplierName =
    text(obj(party.PartyName).Name) ??
    ([text(person.FirstName), text(person.FamilyName)].filter(Boolean).join(" ") || null);

  const rawLines = arr(inv.InvoiceLine);
  if (rawLines.length === 0) throw new UblError("Faturada satır (InvoiceLine) yok.");

  // Belge geneli iskonto / masraf
  let docDiscount = ZERO;
  for (const ac of arr(inv.AllowanceCharge)) {
    const isCharge = text(ac.ChargeIndicator) === "true";
    const amt = num(ac.Amount) ?? ZERO;
    docDiscount = isCharge ? docDiscount.minus(amt) : docDiscount.plus(amt);
  }

  const prelim = rawLines.map((l, i) => {
    const item = obj(l.Item);
    const qtyNode = l.InvoicedQuantity;
    const q = num(qtyNode);
    if (!q || q.lte(0)) throw new UblError(`${i + 1}. satırda miktar yok veya sıfır.`);
    const ext = num(l.LineExtensionAmount);
    if (ext === null) throw new UblError(`${i + 1}. satırda tutar (LineExtensionAmount) yok.`);
    const vat = lineVat(l);
    if (vat.otherTaxes.gt(0)) warnings.push(`${i + 1}. satırdaki KDV dışı vergiler (${vat.otherTaxes.toFixed(2)} TL) maliyete eklendi.`);
    let lineDisc = ZERO;
    for (const ac of arr(l.AllowanceCharge)) if (text(ac.ChargeIndicator) !== "true") lineDisc = lineDisc.plus(num(ac.Amount) ?? ZERO);
    const ids = [
      text(obj(item.StandardItemIdentification).ID),
      text(obj(item.SellersItemIdentification).ID),
      text(obj(item.ManufacturersItemIdentification).ID),
      text(obj(item.BuyersItemIdentification).ID),
    ];
    const barcode = ids.find((x) => x && BARCODE_RE.test(x)) ?? null;
    const unitCode = attr(qtyNode, "unitCode") ?? "";
    const unit = resolveUnit(unitCode);
    return {
      name: text(item.Name) ?? text(item.Description) ?? `Satır ${i + 1}`,
      code: text(obj(item.SellersItemIdentification).ID),
      barcode,
      unitCode,
      unit,
      qty: q,
      price: num(obj(l.Price).PriceAmount) ?? money(ext.div(q)),
      ext: ext.plus(vat.otherTaxes),
      lineDisc,
      vatRate: vat.rate,
      vatAmount: vat.amount,
    };
  });

  const shares = allocateDocDiscount(inv, prelim, docDiscount);
  if (!docDiscount.isZero()) warnings.push(`Belge geneli ${docDiscount.isNegative() ? "masraf" : "iskonto"} (${docDiscount.abs().toFixed(2)} TL) satırlara tutarları oranında dağıtıldı.`);

  const lines: StageLine[] = prelim.map((p, i) => {
    const net = money(p.ext.minus(shares[i]!));
    // Belge iskontosu dağıtıldıysa KDV de yeni nete göre yeniden hesaplanır
    const vatAmount = shares[i]!.isZero() ? money(p.vatAmount) : money(net.times(p.vatRate).div(100));
    return {
      line_no: i + 1,
      name: p.name,
      code: p.code,
      barcode: p.barcode,
      unit_code: p.unitCode,
      unit_name: p.unit.label || p.unitCode || null,
      unit_kind: p.unit.kind,
      unit_base: p.unit.base,
      unit_scale: p.unit.scale?.toString() ?? null,
      qty: qty3(p.qty).toString(),
      unit_price: money(p.price).toString(),
      discount_amount: money(p.lineDisc.plus(shares[i]!)).toString(),
      line_net: net.toString(),
      vat_rate: p.vatRate.toString(),
      vat_amount: vatAmount.toString(),
    };
  });

  const calc = invoiceTotals(lines.map((l) => ({ lineNet: l.line_net, vatAmount: l.vat_amount })));
  const lmt = obj(inv.LegalMonetaryTotal);
  const docExcl = num(lmt.TaxExclusiveAmount);
  const docIncl = num(lmt.TaxInclusiveAmount);
  // Belge KDV toplamı: sadece KDV (0015) alt kırılımları
  const docTax = obj(Array.isArray(inv.TaxTotal) ? inv.TaxTotal[0] : inv.TaxTotal);
  const docVatSubs = arr(docTax.TaxSubtotal).filter((s) => {
    const c = text(obj(obj(s.TaxCategory).TaxScheme).TaxTypeCode);
    return c === null || c === "0015";
  });
  const docVat = docVatSubs.length ? sum(docVatSubs.map((s) => num(s.TaxAmount))) : num(docTax.TaxAmount);
  // KDV dışı vergi (ÖTV vb.) maliyete eklendiği için KDV hariç toplam o durumda karşılaştırılmaz.
  const hasOtherTaxes = warnings.some((w) => w.includes("KDV dışı vergiler"));
  const cmp = compareTotals({ exclVat: hasOtherTaxes ? null : docExcl, vat: docVat, inclVat: docIncl }, calc);
  if (cmp.mismatch) warnings.push("Fatura toplamı satırlardan hesaplanan toplamla 0,05 TL'den fazla farklı. Faturayı kontrol edin.");

  return {
    header: {
      invoice_no: invoiceNo,
      ettn: text(inv.UUID),
      invoice_date: date,
      invoice_type: type,
      profile: text(inv.ProfileID),
      supplier_name: supplierName,
      supplier_tax_number: taxNo && /^\d{10,11}$/.test(taxNo) ? taxNo : null,
      doc_total_excl_vat: docExcl?.toString() ?? null,
      doc_total_vat: docVat?.toString() ?? null,
      doc_total_incl_vat: docIncl?.toString() ?? null,
      calc_total_excl_vat: calc.exclVat.toString(),
      calc_total_vat: calc.vat.toString(),
      calc_total_incl_vat: calc.inclVat.toString(),
      total_mismatch: cmp.mismatch,
    },
    lines,
    warnings,
  };
}
