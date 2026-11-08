import { createHash } from "node:crypto";
import { dec, money, qty as qty3, ZERO, type Dec } from "@/lib/domain/decimal";
import { addVat, splitGross, isValidVatRate } from "@/lib/domain/vat";
import { resolveUnit } from "@/lib/domain/units";
import { computeLine, invoiceTotals } from "@/lib/domain/invoice";
import { isIsoDate } from "@/lib/domain/dates";
import type { Cell } from "./read";
import { parseLocaleNumber, type DecimalSeparator } from "./number";
import { parseDateCell, type DateFormat } from "./date";
import { cleanBarcode, cleanText, normalizeName } from "./normalize";
import type { ImportKind } from "./fields";

export type RowStatus = "ok" | "warning" | "error" | "duplicate" | "needs_review" | "skipped";

export interface ProfileOptions {
  decimalSeparator: DecimalSeparator;
  dateFormat: DateFormat;
  /** fiyat alanı → KDV dahil mi */
  vatIncluded: Record<string, boolean>;
  /** Tartılı (kg) ürünlerde miktar gram olarak mı geliyor */
  weighedQtyInGrams?: boolean;
}

export interface ProductRef {
  id: string;
  name: string;
  name_norm: string | null;
  barcode: string | null;
  code: string | null;
  base_unit: "adet" | "kg" | "lt";
}

export interface TransformContext {
  products: ProductRef[];
  /** ürün + tarih → KDV oranı (yoksa null) */
  vatRate: (productId: string, date: string) => string | null;
  /** ürün listesi: tarihteki hesaplanan stok ve açılış var mı */
  stockAt?: Map<string, { stock: string | null; hasOpening: boolean }>;
}

export interface StagedRow {
  row_number: number;
  raw: Record<string, Cell>;
  parsed: Record<string, unknown> | null;
  status: RowStatus;
  messages: string[];
  product_id: string | null;
}

export interface TransformParams {
  period_start?: string;
  period_end?: string;
  stock_date?: string;
  invoice_no?: string;
  invoice_date?: string;
}

export interface TransformResult {
  rows: StagedRow[];
  counts: Record<RowStatus, number>;
}

// ---------------------------------------------------------------------------
// Ürün eşleştirme: barkod → stok kodu → ad (tekil ise)
// ---------------------------------------------------------------------------
export class ProductIndex {
  private byBarcode = new Map<string, ProductRef>();
  private byCode = new Map<string, ProductRef>();
  private byName = new Map<string, ProductRef[]>();

  constructor(products: ProductRef[]) {
    for (const p of products) {
      if (p.barcode) this.byBarcode.set(p.barcode, p);
      if (p.code) this.byCode.set(p.code, p);
      const n = p.name_norm ?? normalizeName(p.name);
      if (n) this.byName.set(n, [...(this.byName.get(n) ?? []), p]);
    }
  }

  find(barcode: string | null, code: string | null, name: string | null): { product: ProductRef | null; ambiguous: boolean; via: string | null } {
    if (barcode) {
      const p = this.byBarcode.get(barcode);
      if (p) return { product: p, ambiguous: false, via: "barcode" };
    }
    if (code) {
      const p = this.byCode.get(code);
      if (p) return { product: p, ambiguous: false, via: "code" };
    }
    const n = normalizeName(name);
    if (n && !barcode && !code) {
      const hits = this.byName.get(n) ?? [];
      if (hits.length === 1) return { product: hits[0]!, ambiguous: false, via: "name" };
      if (hits.length > 1) return { product: null, ambiguous: true, via: null };
    }
    return { product: null, ambiguous: false, via: null };
  }
}

// ---------------------------------------------------------------------------
// Yardımcılar
// ---------------------------------------------------------------------------
function rowObject(headers: string[], row: Cell[]): Record<string, Cell> {
  const o: Record<string, Cell> = {};
  headers.forEach((h, i) => {
    o[h] = row[i] ?? null;
  });
  return o;
}

function isEmptyRow(row: Cell[]): boolean {
  return row.every((c) => c === null || c === "" || (typeof c === "string" && c.trim() === ""));
}

class RowReader {
  messages: string[] = [];
  errors = 0;
  constructor(
    private raw: Record<string, Cell>,
    private mapping: Record<string, string | undefined>,
    private opts: ProfileOptions,
  ) {}

  has(key: string): boolean {
    return !!this.mapping[key];
  }
  cell(key: string): Cell {
    const h = this.mapping[key];
    return h ? (this.raw[h] ?? null) : null;
  }
  text(key: string): string | null {
    return cleanText(this.cell(key));
  }
  barcode(key: string): string | null {
    return cleanBarcode(this.cell(key));
  }
  num(key: string, label: string, opts: { required?: boolean } = {}): Dec | null {
    const r = parseLocaleNumber(this.cell(key), this.opts.decimalSeparator);
    if (r.error) {
      this.messages.push(`${label}: ${r.error}`);
      this.errors++;
      return null;
    }
    if (r.value === null && opts.required) {
      this.messages.push(`${label} boş`);
      this.errors++;
    }
    return r.value;
  }
  date(key: string, label: string): { date: string | null; timestamp: string | null } {
    const r = parseDateCell(this.cell(key), this.opts.dateFormat);
    if (r.error) {
      this.messages.push(`${label}: ${r.error}`);
      this.errors++;
    }
    return r;
  }
  warn(msg: string) {
    this.messages.push(msg);
  }
  fail(msg: string) {
    this.messages.push(msg);
    this.errors++;
  }
}

function counts(rows: StagedRow[]): Record<RowStatus, number> {
  const c: Record<RowStatus, number> = { ok: 0, warning: 0, error: 0, duplicate: 0, needs_review: 0, skipped: 0 };
  rows.forEach((r) => c[r.status]++);
  return c;
}

function parseBaseUnit(v: string | null): { unit: "adet" | "kg" | "lt"; known: boolean } {
  if (!v) return { unit: "adet", known: true };
  const u = resolveUnit(v);
  if (u.kind === "base" && u.base) return { unit: u.base, known: true };
  if (u.kind === "scaled" && u.base) return { unit: u.base, known: true };
  return { unit: "adet", known: false };
}

function vatOf(r: RowReader, product: ProductRef | null, ctx: TransformContext, date: string): Dec | null {
  if (r.has("vat_rate")) {
    const v = r.num("vat_rate", "KDV oranı");
    if (v !== null) {
      // "0,20" gibi oran yazılmışsa yüzdeye çevir
      const pct = v.gt(0) && v.lt(1) ? v.times(100) : v;
      if (!isValidVatRate(pct)) {
        r.fail(`KDV oranı geçersiz: ${v.toString()}`);
        return null;
      }
      return pct;
    }
  }
  if (product) {
    const rate = ctx.vatRate(product.id, date);
    if (rate !== null) return dec(rate);
  }
  return null;
}

function scaleQty(q: Dec, product: ProductRef | null, opts: ProfileOptions): Dec {
  return opts.weighedQtyInGrams && product?.base_unit === "kg" ? q.times("0.001") : q;
}

// ---------------------------------------------------------------------------
// Dönüşüm
// ---------------------------------------------------------------------------
const TOTAL_ROW = /^(genel\s*|ara\s*)?(toplam|total|yekün)\b/i;
export function transformRows(
  kind: Exclude<ImportKind, "purchase_invoice_table">,
  rows: Cell[][],
  headerRow: number,
  headers: string[],
  mapping: Record<string, string | undefined>,
  opts: ProfileOptions,
  params: TransformParams,
  ctx: TransformContext,
): TransformResult {
  const index = new ProductIndex(ctx.products);
  const out: StagedRow[] = [];
  const seenProducts = new Map<string, number>();
  const seenKeys = new Map<string, number>();
  const fpCount = new Map<string, number>();

  for (let i = headerRow + 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    if (isEmptyRow(row)) continue;
    const raw = rowObject(headers, row);
    const r = new RowReader(raw, mapping, opts);
    const rowNumber = i + 1; // dosyadaki satır numarası (1'den)
    const barcode = r.barcode("barcode");
    const code = r.text("code");
    const name = r.text("name");
    const found = index.find(barcode, code, name);
    const product = found.product;
    let status: RowStatus = "ok";
    let parsed: Record<string, unknown> | null = null;

    if ((!barcode && !code && !name) || (!barcode && !code && name && TOTAL_ROW.test(name))) {
      out.push({ row_number: rowNumber, raw, parsed: null, status: "skipped", messages: ["Ürün bilgisi yok (toplam/ara satır olabilir)"], product_id: null });
      continue;
    }

    if (kind === "product_list") {
      const key = barcode ?? code ?? normalizeName(name) ?? "";
      if (seenKeys.has(key)) {
        out.push({ row_number: rowNumber, raw, parsed: null, status: "duplicate", messages: [`Aynı ürün dosyada ${seenKeys.get(key)}. satırda da var`], product_id: product?.id ?? null });
        continue;
      }
      seenKeys.set(key, rowNumber);
      if (!name) r.fail("Ürün adı boş");
      const bu = parseBaseUnit(r.text("base_unit"));
      if (!bu.known) r.warn(`Birim "${r.text("base_unit")}" tanınmadı; adet kabul edildi`);
      if (product && product.base_unit !== bu.unit && r.has("base_unit")) {
        r.warn(`Kayıtlı birim ${product.base_unit}, listede ${bu.unit}: birim değiştirilmedi`);
      }
      const date = params.stock_date ?? "";
      const vat = vatOf(r, product, ctx, date);
      const saleRaw = r.has("sale_price") ? r.num("sale_price", "Satış fiyatı") : null;
      const purchaseRaw = r.has("purchase_price") ? r.num("purchase_price", "Alış fiyatı") : null;
      let saleGross: Dec | null = null;
      let purchaseNet: Dec | null = null;
      if ((saleRaw || purchaseRaw) && vat === null) {
        r.fail("KDV oranı yok; fiyatlar KDV hariçe çevrilemez. KDV sütununu eşleştirin.");
      } else if (vat !== null) {
        if (saleRaw) saleGross = opts.vatIncluded.sale_price ? money(saleRaw) : addVat(saleRaw, vat).gross;
        if (purchaseRaw) purchaseNet = opts.vatIncluded.purchase_price ? splitGross(purchaseRaw, vat).net : money(purchaseRaw);
      }
      if (saleGross?.isNegative() || purchaseNet?.isNegative()) r.fail("Fiyat eksi olamaz");
      const stockRaw = r.has("stock_qty") ? r.num("stock_qty", "Stok miktarı") : null;
      const stock = stockRaw ? qty3(scaleQty(stockRaw, product ?? ({ base_unit: bu.unit } as ProductRef), opts)) : null;
      parsed = {
        name, barcode, code, base_unit: product?.base_unit ?? bu.unit, category: r.text("category"),
        vat_rate: vat?.toString() ?? null, sale_price_gross: saleGross?.toString() ?? null,
        list_purchase_price_net: purchaseNet?.toString() ?? null, stock_qty: stock?.toString() ?? null,
        is_new: !product, matched_by: found.via,
      };
      if (stock && product && ctx.stockAt) {
        const s = ctx.stockAt.get(product.id);
        if (s?.hasOpening) {
          const calc = dec(s.stock ?? "0");
          const diff = qty3(stock.lt(0) ? ZERO.minus(calc) : stock.minus(calc));
          parsed.calc_stock = calc.toString();
          if (!diff.isZero()) {
            parsed.count_diff = diff.toString();
            parsed.apply_count = false;
            r.warn(`Hesaplanan stok ${calc.toString()}, listede ${stock.toString()} (fark ${diff.toString()})`);
          }
        }
      }
      if (stock?.isNegative()) r.warn("POS'ta stok eksi görünüyor; 0 kabul edilecek. Sayım önerilir.");
      if (found.ambiguous) r.warn("Aynı adla birden fazla ürün var; yeni ürün olarak eklenecek");
      status = r.errors ? "error" : r.messages.length ? "warning" : "ok";
      out.push({ row_number: rowNumber, raw, parsed, status, messages: r.messages, product_id: product?.id ?? null });
      continue;
    }

    // Satış satırları
    if (!product) {
      status = "needs_review";
      r.warn(found.ambiguous ? `"${name}" adıyla birden fazla ürün var; barkod gerekli` : `Ürün bulunamadı (${[barcode, code, name].filter(Boolean).join(" · ")})`);
    }
    if (kind === "sales_summary") {
      if (!params.period_start || !params.period_end || !isIsoDate(params.period_start) || !isIsoDate(params.period_end)) {
        r.fail("Satış dönemi seçilmedi");
      }
      let q = r.num("qty", "Miktar", { required: true });
      let amount = r.num("amount", "Tutar", { required: true });
      const rq = r.has("return_qty") ? r.num("return_qty", "İade miktarı") : null;
      const ra = r.has("return_amount") ? r.num("return_amount", "İade tutarı") : null;
      if (q && rq) q = q.minus(rq.abs());
      if (amount && ra) amount = amount.minus(ra.abs());
      if (q && product) q = scaleQty(q, product, opts);
      const vat = vatOf(r, product, ctx, params.period_end ?? "");
      if (product && vat === null) r.fail("KDV oranı bilinmiyor; ürün listesini yükleyin veya KDV sütununu eşleştirin");
      if (q && amount && q.isZero() && amount.isZero()) {
        out.push({ row_number: rowNumber, raw, parsed: null, status: "skipped", messages: ["Satış yok (0)"], product_id: product?.id ?? null });
        continue;
      }
      if (q?.isNegative()) r.warn("İade satışı aştı (eksi miktar)");
      let parts: { net: Dec; vat: Dec; gross: Dec } | null = null;
      if (amount && vat !== null) {
        parts = opts.vatIncluded.amount
          ? { ...splitGross(amount, vat), gross: money(amount) }
          : { net: money(amount), ...addVat(amount, vat) };
      }
      if (product) {
        const prev = seenProducts.get(product.id);
        if (prev) {
          out.push({ row_number: rowNumber, raw, parsed: null, status: "duplicate", messages: [`Aynı ürün ${prev}. satırda da var; tek satır olmalı`], product_id: product.id });
          continue;
        }
        seenProducts.set(product.id, rowNumber);
      }
      parsed = {
        qty: q ? qty3(q).toString() : null,
        gross_amount: parts?.gross.toString() ?? null,
        net_amount: parts?.net.toString() ?? null,
        vat_amount: parts?.vat.toString() ?? null,
        vat_rate: vat?.toString() ?? null,
        name, barcode, code,
      };
    } else {
      // fiş satırları
      const d = r.date("sold_at", "Tarih");
      let ts = d.timestamp;
      if (d.date && !ts) {
        const t = r.text("time");
        const m = t?.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
        const base = parseDateCell(`${d.date}T${m ? `${m[1]}:${m[2]}:${m[3] ?? "00"}` : "12:00:00"}`, "YYYY-MM-DD");
        ts = base.timestamp;
      }
      if (!d.date) r.fail("Tarih boş");
      let q = r.num("qty", "Miktar", { required: true });
      const amount = r.num("amount", "Tutar", { required: true });
      if (q && product) q = scaleQty(q, product, opts);
      const vat = vatOf(r, product, ctx, d.date ?? "");
      if (product && vat === null) r.fail("KDV oranı bilinmiyor");
      let parts: { net: Dec; vat: Dec; gross: Dec } | null = null;
      if (amount && vat !== null) {
        parts = opts.vatIncluded.amount ? { ...splitGross(amount, vat), gross: money(amount) } : { net: money(amount), ...addVat(amount, vat) };
      }
      const receipt = r.text("receipt_no");
      const base = [receipt ?? "", ts ?? "", barcode ?? code ?? name ?? "", q?.toString() ?? "", amount?.toString() ?? ""].join("|");
      const n = (fpCount.get(base) ?? 0) + 1;
      fpCount.set(base, n);
      parsed = {
        sold_at: ts, receipt_no: receipt, line_no: rowNumber,
        qty: q ? qty3(q).toString() : null,
        gross_amount: parts?.gross.toString() ?? null, net_amount: parts?.net.toString() ?? null,
        vat_amount: parts?.vat.toString() ?? null, vat_rate: vat?.toString() ?? null,
        fingerprint: createHash("sha256").update(`${base}|${n}`).digest("hex"),
        name, barcode, code,
      };
    }
    if (status !== "needs_review") status = r.errors ? "error" : r.messages.length ? "warning" : "ok";
    else if (r.errors) status = "error";
    out.push({ row_number: rowNumber, raw, parsed, status, messages: r.messages, product_id: product?.id ?? null });
  }
  return { rows: out, counts: counts(out) };
}

// ---------------------------------------------------------------------------
// Tablo (Excel/CSV) alış faturası → stage_purchase_invoice girdisi
// ---------------------------------------------------------------------------
export interface StageLine {
  line_no: number;
  name: string;
  code: string | null;
  barcode: string | null;
  unit_code: string;
  unit_name: string | null;
  unit_kind: string;
  unit_base: string | null;
  unit_scale: string | null;
  qty: string;
  unit_price: string;
  discount_amount: string;
  line_net: string;
  vat_rate: string;
  vat_amount: string;
  row_number?: number;
}

export interface StageInvoice {
  invoice_no: string;
  invoice_date: string;
  lines: StageLine[];
  totals: { exclVat: string; vat: string; inclVat: string };
}

export function transformInvoiceTable(
  rows: Cell[][],
  headerRow: number,
  headers: string[],
  mapping: Record<string, string | undefined>,
  opts: ProfileOptions,
  params: TransformParams,
): { staged: StagedRow[]; invoices: StageInvoice[]; counts: Record<RowStatus, number> } {
  const staged: StagedRow[] = [];
  const groups = new Map<string, StageInvoice>();
  for (let i = headerRow + 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    if (isEmptyRow(row)) continue;
    const raw = rowObject(headers, row);
    const r = new RowReader(raw, mapping, opts);
    const rowNumber = i + 1;
    const name = r.text("name");
    if (!name) {
      staged.push({ row_number: rowNumber, raw, parsed: null, status: "skipped", messages: ["Ürün adı yok (toplam/ara satır olabilir)"], product_id: null });
      continue;
    }
    const invoiceNo = r.text("invoice_no") ?? params.invoice_no ?? null;
    const dateCell = r.has("invoice_date") ? r.date("invoice_date", "Fatura tarihi").date : null;
    const invoiceDate = dateCell ?? params.invoice_date ?? null;
    if (!invoiceNo) r.fail("Fatura no yok");
    if (!invoiceDate || !isIsoDate(invoiceDate)) r.fail("Fatura tarihi yok");
    const q = r.num("qty", "Miktar", { required: true });
    if (q && q.lte(0)) r.fail("Miktar sıfırdan büyük olmalı (iade faturaları desteklenmiyor)");
    const vat = r.num("vat_rate", "KDV oranı", { required: true });
    const vatPct = vat && vat.gt(0) && vat.lt(1) ? vat.times(100) : vat;
    if (vatPct && !isValidVatRate(vatPct)) r.fail("KDV oranı geçersiz");
    let price = r.num("unit_price", "Birim fiyat", { required: true });
    let lineTotal = r.has("line_total") ? r.num("line_total", "Satır tutarı") : null;
    if (vatPct && price && opts.vatIncluded.unit_price) price = splitGross(price, vatPct).net;
    if (vatPct && lineTotal && opts.vatIncluded.line_total) lineTotal = splitGross(lineTotal, vatPct).net;
    const disc = r.has("discount") ? r.num("discount", "İskonto") : null;
    const discPct = r.has("discount_pct") ? r.num("discount_pct", "İskonto %") : null;
    const unitText = r.text("unit");
    const unit = unitText ? resolveUnit(unitText) : { kind: "base" as const, base: null, scale: null, label: "" };
    if (r.errors || !q || !price || !vatPct || !invoiceNo || !invoiceDate) {
      staged.push({ row_number: rowNumber, raw, parsed: null, status: "error", messages: r.messages, product_id: null });
      continue;
    }
    const line = computeLine({ qty: q, unitPrice: price, discountAmount: disc, discountPct: discPct, docLineNet: lineTotal, vatRate: vatPct });
    const key = `${invoiceNo}|${invoiceDate}`;
    const inv = groups.get(key) ?? { invoice_no: invoiceNo, invoice_date: invoiceDate, lines: [], totals: { exclVat: "0", vat: "0", inclVat: "0" } };
    const sl: StageLine = {
      line_no: inv.lines.length + 1, name, code: r.text("code"), barcode: r.barcode("barcode"),
      unit_code: unitText ?? "", unit_name: unit.label || unitText, unit_kind: unit.kind,
      unit_base: unit.base, unit_scale: unit.scale?.toString() ?? null,
      qty: qty3(q).toString(), unit_price: money(price).toString(), discount_amount: line.discountAmount.toString(),
      line_net: line.lineNet.toString(), vat_rate: vatPct.toString(), vat_amount: line.vatAmount.toString(), row_number: rowNumber,
    };
    inv.lines.push(sl);
    groups.set(key, inv);
    staged.push({ row_number: rowNumber, raw, parsed: { ...sl }, status: r.messages.length ? "warning" : "ok", messages: r.messages, product_id: null });
  }
  const invoices = [...groups.values()].map((inv) => {
    const t = invoiceTotals(inv.lines.map((l) => ({ lineNet: l.line_net, vatAmount: l.vat_amount })));
    return { ...inv, totals: { exclVat: t.exclVat.toString(), vat: t.vat.toString(), inclVat: t.inclVat.toString() } };
  });
  return { staged, invoices, counts: counts(staged) };
}
