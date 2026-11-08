import { normalizeHeader } from "./normalize";

export type ImportKind = "product_list" | "sales_summary" | "sales_receipts" | "purchase_invoice_table";
export type FieldType = "text" | "barcode" | "number" | "money" | "qty" | "rate" | "date" | "datetime" | "time" | "unit";

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  /** Fiyat alanı: profilde "KDV dahil mi?" sorulur */
  price?: boolean;
  help?: string;
  /** Otomatik eşleştirme önerisi için başlık eş anlamlıları (normalize edilmiş) */
  synonyms: string[];
}

export const KIND_LABEL: Record<ImportKind | "purchase_invoice_xml", string> = {
  product_list: "Ürün / stok listesi",
  sales_summary: "Satış raporu (dönem toplamı)",
  sales_receipts: "Satış (fiş satırları)",
  purchase_invoice_table: "Alış faturası (Excel/CSV)",
  purchase_invoice_xml: "Alış faturası (e-Fatura XML)",
};

const ID_FIELDS: FieldDef[] = [
  { key: "barcode", label: "Barkod", type: "barcode", synonyms: ["barkod", "barcode", "barkod no", "ean", "gtin"] },
  { key: "code", label: "Stok kodu", type: "text", synonyms: ["stok kodu", "urun kodu", "kod", "stok kod", "plu", "malzeme kodu"] },
  { key: "name", label: "Ürün adı", type: "text", synonyms: ["urun adi", "stok adi", "urun", "aciklama", "malzeme adi", "ad", "urun ismi", "stok ismi"] },
];

export const FIELDS: Record<ImportKind, FieldDef[]> = {
  product_list: [
    ...ID_FIELDS.map((f) => (f.key === "name" ? { ...f, required: true } : f)),
    { key: "base_unit", label: "Birim", type: "unit", help: "adet, kg veya lt. Boşsa adet kabul edilir.", synonyms: ["birim", "olcu birimi", "birimi", "unit"] },
    { key: "category", label: "Kategori / grup", type: "text", synonyms: ["kategori", "grup", "stok grubu", "urun grubu", "reyon"] },
    { key: "vat_rate", label: "KDV oranı (%)", type: "rate", synonyms: ["kdv", "kdv orani", "kdv %", "vergi orani", "kdv yuzde"] },
    { key: "purchase_price", label: "Alış fiyatı", type: "money", price: true, synonyms: ["alis fiyati", "alis", "maliyet", "son alis fiyati", "alis fiyat"] },
    { key: "sale_price", label: "Satış fiyatı", type: "money", price: true, synonyms: ["satis fiyati", "satis", "fiyat", "perakende fiyat", "etiket fiyati", "satis fiyat"] },
    { key: "stock_qty", label: "Stok miktarı", type: "qty", synonyms: ["stok", "miktar", "mevcut", "stok miktari", "kalan", "eldeki miktar"] },
  ],
  sales_summary: [
    ...ID_FIELDS,
    { key: "qty", label: "Satış miktarı", type: "qty", required: true, synonyms: ["miktar", "satis miktari", "adet", "satilan", "satilan miktar", "toplam miktar"] },
    { key: "amount", label: "Satış tutarı", type: "money", price: true, required: true, synonyms: ["tutar", "satis tutari", "toplam", "toplam tutar", "ciro", "net tutar"] },
    { key: "vat_rate", label: "KDV oranı (%)", type: "rate", help: "Boşsa ürünün kayıtlı KDV oranı kullanılır.", synonyms: ["kdv", "kdv orani", "kdv %"] },
    { key: "return_qty", label: "İade miktarı", type: "qty", help: "Ayrı sütundaysa. Satıştan düşülür.", synonyms: ["iade miktari", "iade", "iade adet"] },
    { key: "return_amount", label: "İade tutarı", type: "money", price: true, synonyms: ["iade tutari"] },
  ],
  sales_receipts: [
    { key: "sold_at", label: "Tarih / saat", type: "datetime", required: true, synonyms: ["tarih", "fis tarihi", "islem tarihi", "satis tarihi", "tarih saat"] },
    { key: "time", label: "Saat (ayrı sütunsa)", type: "time", synonyms: ["saat", "fis saati"] },
    { key: "receipt_no", label: "Fiş no", type: "text", synonyms: ["fis no", "fis numarasi", "belge no", "fis"] },
    ...ID_FIELDS,
    { key: "qty", label: "Miktar", type: "qty", required: true, synonyms: ["miktar", "adet"] },
    { key: "amount", label: "Satır tutarı", type: "money", price: true, required: true, synonyms: ["tutar", "satir tutari", "toplam", "net tutar"] },
    { key: "vat_rate", label: "KDV oranı (%)", type: "rate", synonyms: ["kdv", "kdv orani"] },
  ],
  purchase_invoice_table: [
    { key: "invoice_no", label: "Fatura no", type: "text", help: "Boşsa yükleme formundaki fatura no kullanılır.", synonyms: ["fatura no", "belge no", "fatura numarasi", "evrak no"] },
    { key: "invoice_date", label: "Fatura tarihi", type: "date", synonyms: ["fatura tarihi", "tarih", "belge tarihi"] },
    ...ID_FIELDS.map((f) => (f.key === "name" ? { ...f, required: true } : f)),
    { key: "qty", label: "Miktar", type: "qty", required: true, synonyms: ["miktar", "adet"] },
    { key: "unit", label: "Birim", type: "unit", help: "koli, paket, adet, kg… Boşsa ürünün temel birimi.", synonyms: ["birim", "olcu birimi"] },
    { key: "unit_price", label: "Birim fiyat", type: "money", price: true, required: true, synonyms: ["birim fiyat", "fiyat", "birim fiyati"] },
    { key: "discount", label: "İskonto tutarı", type: "money", synonyms: ["iskonto", "iskonto tutari", "indirim"] },
    { key: "discount_pct", label: "İskonto (%)", type: "rate", synonyms: ["iskonto %", "iskonto orani", "isk %"] },
    { key: "line_total", label: "Satır tutarı", type: "money", price: true, help: "Varsa birim fiyat × miktar yerine bu kullanılır.", synonyms: ["tutar", "satir tutari", "toplam", "mal hizmet tutari"] },
    { key: "vat_rate", label: "KDV oranı (%)", type: "rate", required: true, synonyms: ["kdv", "kdv orani", "kdv %"] },
  ],
};

/** Başlıklardan eşleştirme önerisi. Kullanıcı her zaman görür ve onaylar. */
export function suggestMapping(kind: ImportKind, headers: string[]): Record<string, string> {
  const norm = headers.map((h) => normalizeHeader(h));
  const used = new Set<number>();
  const out: Record<string, string> = {};
  for (const f of FIELDS[kind]) {
    let idx = -1;
    for (const syn of f.synonyms) {
      idx = norm.findIndex((h, i) => !used.has(i) && h === syn);
      if (idx >= 0) break;
    }
    if (idx < 0) {
      for (const syn of f.synonyms) {
        if (syn.length < 4) continue;
        idx = norm.findIndex((h, i) => !used.has(i) && h.includes(syn));
        if (idx >= 0) break;
      }
    }
    if (idx >= 0) {
      used.add(idx);
      out[f.key] = headers[idx]!;
    }
  }
  return out;
}

export function priceFields(kind: ImportKind): FieldDef[] {
  return FIELDS[kind].filter((f) => f.price);
}

export function missingRequired(kind: ImportKind, mapping: Record<string, string | undefined>): FieldDef[] {
  const req = FIELDS[kind].filter((f) => f.required && !mapping[f.key]);
  const ids = ["barcode", "code", "name"];
  const needsId = kind !== "product_list" && !ids.some((k) => mapping[k]);
  return needsId ? [...req, { key: "barcode", label: "Barkod, stok kodu veya ürün adından en az biri", type: "text", synonyms: [] }] : req;
}
