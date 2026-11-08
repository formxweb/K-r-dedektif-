import { createHash } from "node:crypto";
import type { Cell } from "./read";
import { normalizeHeader } from "./normalize";

/**
 * Başlık satırını bulur: ilk 30 satırda, en az 2 dolu ve çoğu metin olan, kendisinden sonra
 * veri satırları gelen ilk satır. Rapor başlığı / tarih satırları atlanır.
 */
export function detectHeaderRow(rows: Cell[][]): number {
  const limit = Math.min(rows.length, 30);
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < limit; i++) {
    const r = rows[i] ?? [];
    const filled = r.filter((c) => c !== null && c !== "");
    if (filled.length < 2) continue;
    const texty = filled.filter((c) => typeof c === "string" && !/^[\d.,\s-]+$/.test(c)).length;
    const unique = new Set(filled.map((c) => normalizeHeader(c))).size;
    const next = rows[i + 1] ?? [];
    const nextFilled = next.filter((c) => c !== null && c !== "").length;
    const score = texty * 2 + unique + (nextFilled >= filled.length / 2 ? 3 : 0) - (texty < filled.length * 0.6 ? 10 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

export function headersAt(rows: Cell[][], index: number): string[] {
  const r = rows[index] ?? [];
  const seen = new Map<string, number>();
  return r.map((c, i) => {
    let h = c === null || c === "" ? `Sütun ${i + 1}` : String(c).trim();
    const n = seen.get(h) ?? 0;
    seen.set(h, n + 1);
    if (n > 0) h = `${h} (${n + 1})`;
    return h;
  });
}

/** Aynı başlıklara sahip dosyalar aynı imzayı üretir → profil otomatik bulunur. */
export function headerSignature(headers: string[]): string {
  const norm = headers.map((h) => normalizeHeader(h)).filter((h) => h && !/^sutun \d+$/.test(h));
  return createHash("sha256").update(norm.join("|")).digest("hex");
}
