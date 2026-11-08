import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { parseLocaleNumber, detectDecimalSeparator } from "@/lib/import/number";
import { parseDateCell } from "@/lib/import/date";
import { readTable } from "@/lib/import/read";
import { detectHeaderRow, headersAt, headerSignature } from "@/lib/import/header";
import { suggestMapping, missingRequired } from "@/lib/import/fields";
import { transformRows, transformInvoiceTable, type ProductRef, type TransformContext } from "@/lib/import/transform";
import { parseUblInvoice, UblError } from "@/lib/import/ubl";
import { normalizeName } from "@/lib/import/normalize";

const n = (v: unknown, sep: "," | "." = ",") => parseLocaleNumber(v, sep).value?.toString() ?? null;

describe("sayı okuma (float yok)", () => {
  it("Türkçe biçim", () => {
    expect(n("12.450,75")).toBe("12450.75");
    expect(n("1,5")).toBe("1.5");
    expect(n("1.234.567,8")).toBe("1234567.8");
    expect(n("₺ 12,00")).toBe("12");
    expect(n("12,00 TL")).toBe("12");
    expect(n("-3")).toBe("-3");
    expect(n("3-")).toBe("-3");
    expect(n("(3,5)")).toBe("-3.5");
    expect(n("")).toBeNull();
  });
  it("İngilizce biçim", () => {
    expect(n("12,450.75", ".")).toBe("12450.75");
    expect(n("0.5", ".")).toBe("0.5");
  });
  it("Excel sayı hücresi", () => {
    expect(n(12.45)).toBe("12.45");
    expect(n(0.1 + 0.2)).toBe("0.30000000000000004"); // ham değer; para/miktar alanında 4/3 haneye yuvarlanır
  });
  it("hatalı biçimi reddeder", () => {
    expect(parseLocaleNumber("12,45,6", ",").error).toBeTruthy();
    expect(parseLocaleNumber("1.23,4", ",").error).toBeTruthy();
    expect(parseLocaleNumber("abc", ",").error).toBeTruthy();
  });
  it("ondalık ayracını tahmin eder", () => {
    expect(detectDecimalSeparator(["12,50", "3,00", "1.250,00"])).toBe(",");
    expect(detectDecimalSeparator(["12.50", "3.00", "1,250.00"])).toBe(".");
    expect(detectDecimalSeparator(["1.250", "2.500"])).toBeNull(); // belirsiz → kullanıcıya sor
  });
});

describe("tarih okuma", () => {
  it("biçimler ve Excel seri tarihi", () => {
    expect(parseDateCell("08.11.2026", "DD.MM.YYYY").date).toBe("2026-11-08");
    expect(parseDateCell("8/11/2026", "DD.MM.YYYY").date).toBe("2026-11-08");
    expect(parseDateCell("2026-11-08", "DD.MM.YYYY").date).toBe("2026-11-08");
    expect(parseDateCell(46334, "DD.MM.YYYY").date).toBe("2026-11-08");
    expect(parseDateCell("31.02.2026", "DD.MM.YYYY").error).toBeTruthy();
  });
  it("saat İstanbul saatine göre UTC'ye çevrilir", () => {
    expect(parseDateCell("08.11.2026 14:30", "DD.MM.YYYY").timestamp).toBe("2026-11-08T11:30:00.000Z");
  });
});

describe("dosya okuma", () => {
  it("Windows-1254 CSV'yi Türkçe karakterlerle okur", () => {
    // "Ürün Adı;Miktar\nŞeker 1 kg;3\n" — 1254 baytları
    const bytes = new Uint8Array([0xdc, 0x72, 0xfc, 0x6e, 0x20, 0x41, 0x64, 0xfd, 0x3b, 0x4d, 0x69, 0x6b, 0x74, 0x61, 0x72, 0x0a,
      0xde, 0x65, 0x6b, 0x65, 0x72, 0x20, 0x31, 0x20, 0x6b, 0x67, 0x3b, 0x33, 0x0a]);
    const r = readTable(bytes, "satis.csv");
    expect(r.encoding).toBe("windows-1254");
    expect(r.sheets[0]!.rows).toEqual([["Ürün Adı", "Miktar"], ["Şeker 1 kg", "3"]]);
  });
  it("UTF-8 CSV", () => {
    const r = readTable(new TextEncoder().encode("Barkod,Ürün,Tutar\n869,Çay,\"12,50\"\n"), "a.csv");
    expect(r.encoding).toBe("utf-8");
    expect(r.sheets[0]!.rows[1]).toEqual(["869", "Çay", "12,50"]);
  });
  it(".xlsx ve .xls okur, sayılar ham değerdir", () => {
    const ws = XLSX.utils.aoa_to_sheet([["Rapor: Ürün Satışları"], [], ["Barkod", "Ürün Adı", "Miktar", "Tutar"], ["8690000000011", "Çay", 15, 121.2]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sayfa1");
    for (const [type, name] of [["xlsx", "r.xlsx"], ["biff8", "r.xls"]] as const) {
      const buf = XLSX.write(wb, { type: "array", bookType: type }) as ArrayBuffer;
      const r = readTable(new Uint8Array(buf), name);
      const rows = r.sheets[0]!.rows;
      const h = detectHeaderRow(rows);
      expect(h).toBe(2);
      expect(headersAt(rows, h)).toEqual(["Barkod", "Ürün Adı", "Miktar", "Tutar"]);
      expect(rows[3]).toEqual(["8690000000011", "Çay", 15, 121.2]);
    }
  });
  it("desteklenmeyen tür", () => {
    expect(() => readTable(new Uint8Array([1]), "a.pdf")).toThrow(/Desteklenen dosya türleri/);
  });
});

describe("başlık ve eşleştirme", () => {
  it("aynı başlıklar aynı imza (büyük/küçük harf, Türkçe karakter farkı yok sayılır)", () => {
    expect(headerSignature(["Barkod", "Ürün Adı", "Miktar"])).toBe(headerSignature(["BARKOD", "URUN ADI", "miktar"]));
    expect(headerSignature(["Barkod", "Ürün Adı"])).not.toBe(headerSignature(["Barkod", "Ürün Adı", "Miktar"]));
  });
  it("eşleştirme önerisi kullanıcıya sunulur", () => {
    const m = suggestMapping("sales_summary", ["Barkod", "Ürün Adı", "Satış Miktarı", "Satış Tutarı", "KDV %"]);
    expect(m).toEqual({ barcode: "Barkod", name: "Ürün Adı", qty: "Satış Miktarı", amount: "Satış Tutarı", vat_rate: "KDV %" });
    expect(missingRequired("sales_summary", { barcode: "Barkod" }).map((f) => f.key)).toEqual(["qty", "amount"]);
  });
  it("ad normalizasyonu veritabanıyla aynı", () => {
    expect(normalizeName("ÇAYKUR RİZE  Turist, 1 KG!")).toBe("çaykur rize turist, 1 kg");
    expect(normalizeName("IŞIK")).toBe("ışık");
  });
});

const products: ProductRef[] = [
  { id: "p1", name: "Çaykur Rize Turist 1 kg", name_norm: "çaykur rize turist 1 kg", barcode: "8690000000011", code: "CAY1", base_unit: "adet" },
  { id: "p2", name: "Domates", name_norm: "domates", barcode: null, code: "PLU5", base_unit: "kg" },
];
const ctx: TransformContext = { products, vatRate: (id) => (id === "p1" ? "1" : id === "p2" ? "1" : null) };
const opts = { decimalSeparator: "," as const, dateFormat: "DD.MM.YYYY" as const, vatIncluded: { amount: true, sale_price: true, purchase_price: false } };

describe("satış raporu dönüşümü", () => {
  const rows = [
    ["Barkod", "Ürün", "Miktar", "Tutar"],
    ["8690000000011", "Çaykur", "15", "121,20"],
    ["", "Domates", "2.500", "75,00"], // ad ile eşleşmez (stok kodu yok) → ad tekil → eşleşir
    ["999", "Bilinmeyen", "1", "10,00"],
    ["8690000000011", "Çaykur tekrar", "1", "8,08"],
    ["", "TOPLAM", "", ""],
    ["", "", "", ""],
  ];
  const res = transformRows("sales_summary", rows, 0, rows[0] as string[],
    { barcode: "Barkod", name: "Ürün", qty: "Miktar", amount: "Tutar" },
    { ...opts, weighedQtyInGrams: true }, { period_start: "2026-11-01", period_end: "2026-11-07" }, ctx);

  it("KDV dahil tutarı ayırır", () => {
    expect(res.rows[0]).toMatchObject({ status: "ok", product_id: "p1", parsed: { qty: "15", gross_amount: "121.2", net_amount: "120", vat_amount: "1.2", vat_rate: "1" } });
  });
  it("gram → kg çevirir (tartılı ürün)", () => {
    // "2.500" virgül ayraçlı biçimde 2500 gram → 2,5 kg
    expect(res.rows[1]).toMatchObject({ product_id: "p2", parsed: { qty: "2.5" } });
  });
  it("eşleşmeyen ürün onay bekler, tekrar eden ürün işaretlenir, toplam satırı atlanır", () => {
    expect(res.rows[2]!.status).toBe("needs_review");
    expect(res.rows[3]!.status).toBe("duplicate");
    expect(res.rows[4]!.status).toBe("skipped");
    expect(res.rows).toHaveLength(5);
    expect(res.counts).toMatchObject({ ok: 2, needs_review: 1, duplicate: 1, skipped: 1 });
  });
});

describe("ürün listesi dönüşümü", () => {
  it("fiyatları KDV ayarına göre çevirir ve sayım farkını bulur", () => {
    const rows = [
      ["Barkod", "Ad", "Birim", "KDV", "Alış (KDV hariç)", "Satış", "Stok"],
      ["8690000000011", "Çaykur Rize Turist 1 kg", "AD", "1", "200,00", "252,50", "18"],
      ["8690000000099", "Yeni Ürün", "KG", "%20", "10", "18", "-3"],
    ];
    const r = transformRows("product_list", rows, 0, rows[0] as string[],
      { barcode: "Barkod", name: "Ad", base_unit: "Birim", vat_rate: "KDV", purchase_price: "Alış (KDV hariç)", sale_price: "Satış", stock_qty: "Stok" },
      opts, { stock_date: "2026-11-05" }, { ...ctx, stockAt: new Map([["p1", { stock: "20", hasOpening: true }]]) });
    expect(r.rows[0]).toMatchObject({ status: "warning", product_id: "p1", parsed: {
      sale_price_gross: "252.5", list_purchase_price_net: "200", stock_qty: "18", count_diff: "-2", apply_count: false } });
    expect(r.rows[1]).toMatchObject({ product_id: null, parsed: { base_unit: "kg", vat_rate: "20", sale_price_gross: "18", list_purchase_price_net: "10", is_new: true } });
    expect(r.rows[1]!.messages.join(" ")).toMatch(/stok eksi/);
  });
});

describe("Excel/CSV alış faturası", () => {
  it("satırları faturalara gruplar, birimi tanır, toplamı hesaplar", () => {
    const rows = [
      ["Fatura No", "Barkod", "Ürün", "Miktar", "Birim", "Birim Fiyat", "İsk %", "KDV"],
      ["F-1", "8690000000011", "Çay", "2", "Koli", "250,00", "20", "1"],
      ["F-1", "", "Deterjan", "10", "Adet", "13,00", "", "20"],
    ];
    const r = transformInvoiceTable(rows, 0, rows[0] as string[],
      { invoice_no: "Fatura No", barcode: "Barkod", name: "Ürün", qty: "Miktar", unit: "Birim", unit_price: "Birim Fiyat", discount_pct: "İsk %", vat_rate: "KDV" },
      { ...opts, vatIncluded: {} }, { invoice_date: "2026-11-03" });
    expect(r.invoices).toHaveLength(1);
    const inv = r.invoices[0]!;
    expect(inv.lines[0]).toMatchObject({ unit_kind: "package", unit_name: "Koli", line_net: "400", vat_amount: "4" });
    expect(inv.lines[1]).toMatchObject({ unit_kind: "base", unit_base: "adet", line_net: "130", vat_amount: "26" });
    expect(inv.totals).toEqual({ exclVat: "530", vat: "30", inclVat: "560" });
  });
});

describe("e-Fatura (UBL-TR) XML", () => {
  const xml = readFileSync(path.join(__dirname, "fixtures/efatura-ornek.xml"), "utf8");
  const inv = parseUblInvoice(xml);

  it("başlık bilgilerini okur", () => {
    expect(inv.header).toMatchObject({
      invoice_no: "ABC2026000000123", ettn: "3f2b8c1e-5d4a-4e2b-9c7d-1a2b3c4d5e6f", invoice_date: "2026-11-03",
      invoice_type: "SATIS", supplier_name: "Örnek Gıda Toptan Ltd. Şti.", supplier_tax_number: "1234567890",
    });
  });
  it("belge iskontosunu KDV matrahına göre dağıtır; toplamlar belgeyle tutar", () => {
    expect(inv.lines[0]).toMatchObject({ barcode: "8690000000011", code: "CAY-001", unit_code: "BX", unit_kind: "package",
      qty: "2", line_net: "390", vat_amount: "3.9", discount_amount: "110" });
    expect(inv.lines[1]).toMatchObject({ barcode: "8690000000035", unit_kind: "base", unit_base: "adet", line_net: "130", vat_amount: "26" });
    expect(inv.header).toMatchObject({ calc_total_excl_vat: "520", calc_total_vat: "29.9", calc_total_incl_vat: "549.9", total_mismatch: false });
  });
  it("toplam farkını yakalar", () => {
    const bad = parseUblInvoice(xml.replace("<cbc:TaxInclusiveAmount currencyID=\"TRY\">549.90", "<cbc:TaxInclusiveAmount currencyID=\"TRY\">551.00"));
    expect(bad.header.total_mismatch).toBe(true);
  });
  it("iade ve dövizli faturayı açıkça reddeder", () => {
    expect(() => parseUblInvoice(xml.replace(">SATIS<", ">IADE<"))).toThrow(UblError);
    expect(() => parseUblInvoice(xml.replace(">TRY</cbc:DocumentCurrencyCode>", ">USD</cbc:DocumentCurrencyCode>"))).toThrow(/Döviz/);
    expect(() => parseUblInvoice("<a/>")).toThrow(/e-Fatura/);
  });
});
