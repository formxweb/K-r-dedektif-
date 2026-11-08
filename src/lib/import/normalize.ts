/** Veritabanındaki private.normalize_name ile aynı kural (eşleştirme için). */
export function normalizeName(s: string | null | undefined): string | null {
  const t = (s ?? "")
    .replace(/[İIŞĞÜÖÇ]/g, (c) => ({ İ: "i", I: "ı", Ş: "ş", Ğ: "ğ", Ü: "ü", Ö: "ö", Ç: "ç" })[c] ?? c)
    .toLowerCase()
    .replace(/[^a-z0-9çğıöşü,.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t === "" ? null : t;
}

/** Başlık normalizasyonu: büyük/küçük harf, Türkçe karakter ve boşluk farkını yok sayar. */
export function normalizeHeader(h: unknown): string {
  return (normalizeName(String(h ?? "")) ?? "")
    .replace(/ç/g, "c").replace(/ğ/g, "g").replace(/ı/g, "i").replace(/ö/g, "o").replace(/ş/g, "s").replace(/ü/g, "u")
    .replace(/[.,]/g, "")
    .trim();
}

export function cleanBarcode(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  let s = typeof v === "number" ? String(v) : String(v).trim();
  if (/^\d+\.0+$/.test(s)) s = s.split(".")[0]!;
  s = s.replace(/\s+/g, "");
  return s === "" ? null : s;
}

export function cleanText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
}
