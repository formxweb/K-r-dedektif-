"use client";

import { useActionState, useMemo, useState } from "react";
import { stageJob } from "@/server/imports";
import { Field, Input, Select, cx } from "@/components/ui";
import { DirtyGuard, FormMessage, SubmitButton } from "@/components/client";
import type { FieldDef, ImportKind } from "@/lib/import/fields";
import type { Cell } from "@/lib/import/read";

interface Props {
  jobId: string;
  kind: ImportKind;
  fields: FieldDef[];
  rows: Cell[][]; // ilk ~40 satır
  headerRow: number;
  mapping: Record<string, string>;
  suggested: Record<string, string>;
  options: { decimalSeparator?: "," | "."; dateFormat?: string; vatIncluded?: Record<string, boolean>; weighedQtyInGrams?: boolean };
  detectedSeparator: "," | "." | null;
  params: Record<string, string>;
  suppliers: Array<{ id: string; name: string }>;
  profileName: string | null;
  today: string;
}

function headersFor(rows: Cell[][], i: number): string[] {
  const r = rows[i] ?? [];
  const seen = new Map<string, number>();
  return r.map((c, idx) => {
    let h = c === null || c === "" ? `Sütun ${idx + 1}` : String(c).trim();
    const n = seen.get(h) ?? 0;
    seen.set(h, n + 1);
    if (n > 0) h = `${h} (${n + 1})`;
    return h;
  });
}

function show(c: Cell): string {
  if (c === null || c === undefined) return "";
  return String(c);
}

export function MappingForm(p: Props) {
  const [state, action] = useActionState(stageJob, undefined);
  const [headerRow, setHeaderRow] = useState(p.headerRow);
  const headers = useMemo(() => headersFor(p.rows, headerRow), [p.rows, headerRow]);
  const initial = Object.keys(p.mapping).length ? p.mapping : p.suggested;
  const [mapping, setMapping] = useState<Record<string, string>>(initial);
  const samples = p.rows.slice(headerRow + 1, headerRow + 6);
  const colIndex = (h: string | undefined) => (h ? headers.indexOf(h) : -1);

  return (
    <form id="mapping" action={action} className="flex flex-col gap-6" noValidate>
      <DirtyGuard formId="mapping" />
      <input type="hidden" name="job_id" value={p.jobId} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Başlık satırı" htmlFor="header_row" hint="Sütun adlarının yazdığı satır. Raporun üstündeki başlık/tarih satırları atlanır.">
          <Select id="header_row" name="header_row" value={headerRow} onChange={(e) => setHeaderRow(Number(e.target.value))}>
            {p.rows.slice(0, 30).map((r, i) => (
              <option key={i} value={i}>
                {i + 1}. satır: {r.filter((c) => c !== null && c !== "").slice(0, 4).map(show).join(" · ").slice(0, 60) || "(boş)"}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Ondalık ayracı" htmlFor="decimal_separator" hint={p.detectedSeparator ? `Dosyada "${p.detectedSeparator}" görünüyor.` : "Dosyadan anlaşılamadı; örnek satırlara bakarak seçin."}>
          <Select id="decimal_separator" name="decimal_separator" defaultValue={p.options.decimalSeparator ?? p.detectedSeparator ?? ""} required>
            <option value="" disabled>Seçin</option>
            <option value=",">Virgül — 1.234,56</option>
            <option value=".">Nokta — 1,234.56</option>
          </Select>
        </Field>
      </div>

      {/* Parametreler */}
      <div className="grid gap-4 sm:grid-cols-2">
        {p.kind === "sales_summary" && (
          <>
            <Field label="Rapor başlangıç tarihi" htmlFor="period_start" hint="Raporun kapsadığı ilk gün.">
              <Input id="period_start" name="period_start" type="date" max={p.today} defaultValue={p.params.period_start} required />
            </Field>
            <Field label="Rapor bitiş tarihi" htmlFor="period_end" hint="Satışlar bu günün sonuna yazılır.">
              <Input id="period_end" name="period_end" type="date" max={p.today} defaultValue={p.params.period_end} required />
            </Field>
          </>
        )}
        {p.kind === "product_list" && (
          <Field label="Liste hangi günün stoğu?" htmlFor="stock_date" hint="Genelde dosyayı aldığınız gün. İlk listede açılış stoğu bu günün sonuna yazılır.">
            <Input id="stock_date" name="stock_date" type="date" max={p.today} defaultValue={p.params.stock_date ?? p.today} required />
          </Field>
        )}
        {(p.kind === "sales_receipts" || p.kind === "purchase_invoice_table") && (
          <Field label="Tarih biçimi" htmlFor="date_format">
            <Select id="date_format" name="date_format" defaultValue={p.options.dateFormat ?? "DD.MM.YYYY"}>
              <option value="DD.MM.YYYY">GG.AA.YYYY (08.11.2026)</option>
              <option value="YYYY-MM-DD">YYYY-AA-GG (2026-11-08)</option>
              <option value="MM/DD/YYYY">AA/GG/YYYY (11/08/2026)</option>
            </Select>
          </Field>
        )}
        {p.kind === "purchase_invoice_table" && (
          <>
            <Field label="Tedarikçi" htmlFor="supplier_id" hint={p.suppliers.length === 0 ? "Önce Ayarlar › Tedarikçiler'den tedarikçi ekleyin." : undefined}>
              <Select id="supplier_id" name="supplier_id" defaultValue={p.params.supplier_id ?? ""} required>
                <option value="" disabled>Seçin</option>
                {p.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
            <Field label="Fatura no" htmlFor="invoice_no" optional hint="Dosyada fatura no sütunu yoksa.">
              <Input id="invoice_no" name="invoice_no" defaultValue={p.params.invoice_no} />
            </Field>
            <Field label="Fatura tarihi" htmlFor="invoice_date" optional hint="Dosyada tarih sütunu yoksa.">
              <Input id="invoice_date" name="invoice_date" type="date" max={p.today} defaultValue={p.params.invoice_date} />
            </Field>
          </>
        )}
      </div>

      {/* Sütun eşleştirme */}
      <div>
        <h3 className="mb-1 text-[15px] font-semibold">Sütunları eşleştirin</h3>
        <p className="mb-3 text-[13px] text-muted">Her alanın dosyadaki karşılığını seçin. Öneriler başlık adlarından geldi; kontrol edin.</p>
        <div className="overflow-hidden rounded-md border border-line">
          {p.fields.map((f) => {
            const idx = colIndex(mapping[f.key]);
            const sample = idx >= 0 ? samples.map((r) => show(r[idx] ?? null)).filter(Boolean).slice(0, 3) : [];
            return (
              <div key={f.key} className="grid gap-2 border-b border-line bg-surface p-3 last:border-b-0 sm:grid-cols-[220px_1fr_1fr] sm:items-center">
                <label htmlFor={`map_${f.key}`} className="text-[14px] font-medium">
                  {f.label}
                  {f.required ? <span className="ml-1 text-neg" aria-label="zorunlu">*</span> : <span className="ml-1 text-[12px] font-normal text-faint">(isteğe bağlı)</span>}
                  {f.help && <span className="block text-[12px] font-normal text-muted">{f.help}</span>}
                </label>
                <Select id={`map_${f.key}`} name={`map_${f.key}`} value={mapping[f.key] ?? ""} onChange={(e) => setMapping((m) => ({ ...m, [f.key]: e.target.value }))}>
                  <option value="">— Kullanma —</option>
                  {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </Select>
                <div className="num min-h-5 truncate text-[13px] text-muted" title={sample.join(" · ")}>
                  {sample.length ? sample.join(" · ") : idx >= 0 ? "(örnek satırlarda boş)" : ""}
                </div>
                {f.price && mapping[f.key] && (
                  <fieldset className="sm:col-span-3 sm:pl-[220px]">
                    <legend className="sr-only">{f.label}: KDV dahil mi?</legend>
                    <div className="flex flex-wrap gap-2 text-[13px]">
                      {[{ v: "1", l: "Fiyatlar KDV dahil" }, { v: "0", l: "Fiyatlar KDV hariç" }].map((o) => (
                        <label key={o.v} className="inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-md border border-line-strong px-3 has-[:checked]:border-ink-900 has-[:checked]:bg-ink-900 has-[:checked]:text-white">
                          <input type="radio" name={`vat_${f.key}`} value={o.v} defaultChecked={p.options.vatIncluded?.[f.key] === undefined ? undefined : (p.options.vatIncluded[f.key] ? "1" : "0") === o.v} className="sr-only" required />
                          {o.l}
                        </label>
                      ))}
                      <span className="self-center text-faint">Emin değilseniz POS'taki raf fiyatıyla karşılaştırın.</span>
                    </div>
                  </fieldset>
                )}
              </div>
            );
          })}
        </div>
        {(p.kind === "sales_summary" || p.kind === "sales_receipts" || p.kind === "product_list") && (
          <label className="mt-3 flex items-start gap-2 text-[14px]">
            <input type="checkbox" name="grams" value="1" defaultChecked={p.options.weighedQtyInGrams} className="mt-1 h-4 w-4" />
            <span>Tartılı (kg) ürünlerde miktar gram olarak geliyor <span className="block text-[12.5px] text-muted">Örn. 2.500 = 2,5 kg. Emin değilseniz domates gibi bir ürünün satırına bakın.</span></span>
          </label>
        )}
      </div>

      {/* Örnek satırlar */}
      <div>
        <h3 className="mb-2 text-[15px] font-semibold">Dosyanın ilk satırları</h3>
        <div className="overflow-x-auto rounded-md border border-line bg-surface">
          <table className="w-full text-[13px]">
            <thead>
              <tr>{headers.map((h) => <th key={h} className={cx("whitespace-nowrap border-b border-line bg-subtle px-2.5 py-2 text-left font-medium", Object.values(mapping).includes(h) ? "text-text" : "text-faint")}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {samples.map((r, i) => (
                <tr key={i}>{headers.map((h, j) => <td key={h} className="num whitespace-nowrap border-b border-line px-2.5 py-1.5 text-muted last:border-r-0">{show(r[j] ?? null)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid gap-3 rounded-md border border-line bg-subtle p-3 sm:grid-cols-[auto_1fr_1fr] sm:items-end">
        <label className="flex items-center gap-2 text-[14px] sm:pb-2.5">
          <input type="checkbox" name="save_profile" value="1" defaultChecked className="h-4 w-4" />
          Bu eşleştirmeyi profil olarak kaydet
        </label>
        <Field label="Profil adı" htmlFor="profile_name">
          <Input id="profile_name" name="profile_name" defaultValue={p.profileName ?? ""} placeholder="örn. Ürün Satış Raporu" />
        </Field>
        <Field label="POS / program" htmlFor="source_system" optional>
          <Input id="source_system" name="source_system" placeholder="örn. Fenix POS" />
        </Field>
      </div>

      <FormMessage state={state} />
      <div className="sticky bottom-16 z-10 -mx-4 flex gap-2 border-t border-line bg-canvas/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0 lg:bottom-0">
        <SubmitButton pendingText="Satırlar hazırlanıyor…">Satırları hazırla ve önizle</SubmitButton>
      </div>
    </form>
  );
}
