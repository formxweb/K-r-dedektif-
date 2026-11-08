"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { prepareUploads, registerUploads, uploadViaServer } from "@/server/imports";
import { browserStorage } from "@/lib/supabase/browser";
import { Field, Input, buttonClass, cx } from "@/components/ui";
import { FormMessage } from "@/components/client";

const TABLE_EXT = [".xls", ".xlsx", ".csv"];
const MAX_BYTES = 10 * 1024 * 1024;
const FALLBACK_MAX_BYTES = 4 * 1024 * 1024;

const KINDS = [
  { value: "product_list", label: "Ürün / stok listesi", hint: "Barkod, ad, birim, alış ve satış fiyatı, stok, KDV. İlk yüklemede açılış stoğu olur.", ext: TABLE_EXT },
  { value: "sales_summary", label: "Satış raporu (dönem toplamı)", hint: "Ürün başına toplam satış miktarı ve tutarı. Haftalık yüklemek önerilerin güvenini artırır.", ext: TABLE_EXT },
  { value: "sales_receipts", label: "Satış (fiş satırları)", hint: "Her satırda tarih/saat, ürün, miktar ve tutar olan detaylı satış dökümü.", ext: TABLE_EXT },
  { value: "purchase_invoice_xml", label: "Alış faturası — e-Fatura XML", hint: "Tedarikçiden gelen e-Fatura / e-Arşiv XML dosyaları. Birden fazla seçebilirsiniz (en fazla 20).", ext: [".xml"] },
  { value: "purchase_invoice_table", label: "Alış faturası — Excel/CSV", hint: "Fatura satırlarının olduğu tablo. Tedarikçiyi sonraki adımda seçersiniz.", ext: TABLE_EXT },
] as const;

type Msg = { error?: string; message?: string } | null;

function hasExt(name: string, ext: readonly string[]) {
  const n = name.toLowerCase();
  return ext.some((e) => n.endsWith(e)) || (ext === TABLE_EXT && n.endsWith(".txt"));
}

export function UploadForm() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<string>("product_list");
  const [step, setStep] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dupJob, setDupJob] = useState<string | null>(null);
  const k = KINDS.find((x) => x.value === kind)!;
  const isXml = kind === "purchase_invoice_xml";

  function checkFiles(files: File[]): string | null {
    if (files.length === 0) return "Bir dosya seçin.";
    if (!isXml && files.length > 1) return "Bu türde tek seferde bir dosya yüklenir.";
    if (files.length > 20) return "Tek seferde en fazla 20 fatura yükleyebilirsiniz.";
    for (const f of files) {
      if (!hasExt(f.name, k.ext)) return `${f.name}: bu tür için ${k.ext.join(", ")} uzantılı dosya seçin.`;
      if (f.size === 0) return `${f.name}: dosya boş.`;
      if (f.size > MAX_BYTES) return `${f.name}: dosya 10 MB'tan büyük. Raporu daha kısa bir tarih aralığıyla dışa aktarın.`;
    }
    return null;
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (step) return;
    const files = Array.from(inputRef.current?.files ?? []);
    setMsg(null);
    setDupJob(null);
    const err = checkFiles(files);
    setFileError(err);
    if (err) return;
    try {
      setStep("Hazırlanıyor…");
      const plan = await prepareUploads({ kind, files: files.map((f) => ({ name: f.name, size: f.size, type: f.type })) });
      if (plan.error || !plan.uploads) {
        setMsg({ error: plan.error ?? "Yükleme hazırlanamadı." });
        return;
      }
      const storage = browserStorage();
      for (let i = 0; i < files.length; i++) {
        setStep(files.length > 1 ? `Yükleniyor ${i + 1}/${files.length}…` : "Yükleniyor…");
        const f = files[i]!;
        const u = plan.uploads[i]!;
        const { error } = await storage.uploadToSignedUrl(u.path, u.token, f, { contentType: f.type || "application/octet-stream" });
        if (error) {
          // Doğrudan yükleme olmadıysa küçük dosyayı sunucu üzerinden dene.
          const fb = new FormData();
          fb.set("path", u.path);
          fb.set("file", f);
          const r = f.size <= FALLBACK_MAX_BYTES ? await uploadViaServer(fb) : { error: "x" };
          if (r.error) {
            setMsg({ error: `${f.name} yüklenemedi. İnternet bağlantınızı kontrol edip tekrar deneyin.` });
            return;
          }
        }
      }
      setStep("Dosya okunuyor…");
      const res = await registerUploads({
        kind,
        files: files.map((f, i) => ({ path: plan.uploads![i]!.path, name: f.name, size: f.size, type: f.type })),
      });
      if (res.dupJobId) setDupJob(res.dupJobId);
      if (res.redirect) {
        router.push(res.redirect);
        return;
      }
      setMsg({ error: res.error, message: res.message });
      if (res.ok && inputRef.current) inputRef.current.value = "";
      router.refresh();
    } catch {
      setMsg({ error: "Bağlantı koptu. Sayfayı yenileyip tekrar deneyin." });
    } finally {
      setStep(null);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <fieldset className="flex flex-col gap-2" disabled={!!step}>
        <legend className="mb-1 text-[13px] font-medium">Ne yüklüyorsunuz?</legend>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {KINDS.map((x) => (
            <label key={x.value}
              className={`flex min-h-12 cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 text-[14px] transition-colors duration-150 ${kind === x.value ? "border-ink-900 bg-ink-900 text-white" : "border-line-strong bg-surface hover:border-ink-400"}`}>
              <input type="radio" name="kind" value={x.value} checked={kind === x.value}
                onChange={() => { setKind(x.value); setFileError(null); setMsg(null); setDupJob(null); }} className="sr-only" />
              <span className="leading-snug">{x.label}</span>
            </label>
          ))}
        </div>
        <p className="text-[13px] text-muted">{k.hint}</p>
      </fieldset>
      {/* accept bilerek yok: bazı Android dosya seçicileri .xls/.csv'yi gri gösteriyor. Uzantı burada ve sunucuda denetlenir. */}
      <Field label="Dosya" htmlFor="file" error={fileError}
        hint={`Kabul edilen: ${k.ext.join(", ")} · en fazla 10 MB. POS'tan çıktığı gibi yükleyin; Excel'de açıp kaydetmeyin.`}>
        <Input ref={inputRef} key={kind} id="file" name="file" type="file" multiple={isXml} disabled={!!step}
          onChange={() => setFileError(null)}
          className="py-1.5 file:mr-3 file:rounded file:border-0 file:bg-subtle file:px-3 file:py-1.5 file:text-[13px]" />
      </Field>
      <FormMessage state={msg} />
      {dupJob && <Link href={`/veri/${dupJob}`} className="text-[14px] text-accent hover:underline">Önceki aktarımı aç</Link>}
      <div>
        <button type="submit" aria-disabled={!!step} className={buttonClass("primary", cx(step && "opacity-70"))}>
          {step ? (
            <>
              <span aria-hidden className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" />
              {step}
            </>
          ) : "Dosyayı yükle"}
        </button>
      </div>
    </form>
  );
}
