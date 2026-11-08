"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { uploadImport } from "@/server/imports";
import { Field, Input } from "@/components/ui";
import { FormMessage, SubmitButton } from "@/components/client";

const KINDS = [
  { value: "product_list", label: "Ürün / stok listesi", hint: "Barkod, ad, birim, alış ve satış fiyatı, stok, KDV. İlk yüklemede açılış stoğu olur.", accept: ".xls,.xlsx,.csv" },
  { value: "sales_summary", label: "Satış raporu (dönem toplamı)", hint: "Ürün başına toplam satış miktarı ve tutarı. Haftalık yüklemek önerilerin güvenini artırır.", accept: ".xls,.xlsx,.csv" },
  { value: "sales_receipts", label: "Satış (fiş satırları)", hint: "Her satırda tarih/saat, ürün, miktar ve tutar olan detaylı satış dökümü.", accept: ".xls,.xlsx,.csv" },
  { value: "purchase_invoice_xml", label: "Alış faturası — e-Fatura XML", hint: "Tedarikçiden gelen e-Fatura / e-Arşiv XML dosyaları. Birden fazla seçebilirsiniz.", accept: ".xml" },
  { value: "purchase_invoice_table", label: "Alış faturası — Excel/CSV", hint: "Fatura satırlarının olduğu tablo. Tedarikçiyi sonraki adımda seçersiniz.", accept: ".xls,.xlsx,.csv" },
] as const;

export function UploadForm() {
  const [state, action] = useActionState(uploadImport, undefined);
  const [kind, setKind] = useState<string>("product_list");
  const k = KINDS.find((x) => x.value === kind)!;
  const dupJob = state?.data?.jobId as string | undefined;
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-[13px] font-medium">Ne yüklüyorsunuz?</legend>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {KINDS.map((x) => (
            <label key={x.value}
              className={`flex min-h-12 cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 text-[14px] transition-colors duration-150 ${kind === x.value ? "border-ink-900 bg-ink-900 text-white" : "border-line-strong bg-surface hover:border-ink-400"}`}>
              <input type="radio" name="kind" value={x.value} checked={kind === x.value} onChange={() => setKind(x.value)} className="sr-only" />
              <span className="leading-snug">{x.label}</span>
            </label>
          ))}
        </div>
        <p className="text-[13px] text-muted">{k.hint}</p>
      </fieldset>
      <Field label="Dosya" htmlFor="file" error={state?.fieldErrors?.file} hint={`Kabul edilen: ${k.accept.replaceAll(",", ", ")} · en fazla 10 MB. POS'tan çıktığı gibi yükleyin; Excel'de açıp kaydetmeyin.`}>
        <Input key={kind} id="file" name="file" type="file" accept={k.accept} multiple={kind === "purchase_invoice_xml"} required className="py-1.5 file:mr-3 file:rounded file:border-0 file:bg-subtle file:px-3 file:py-1.5 file:text-[13px]" />
      </Field>
      <FormMessage state={state?.error ? { error: state.error } : state} />
      {dupJob && <Link href={`/veri/${dupJob}`} className="text-[14px] text-accent hover:underline">Önceki aktarımı aç</Link>}
      <div>
        <SubmitButton pendingText="Yükleniyor…">Dosyayı yükle</SubmitButton>
      </div>
    </form>
  );
}
