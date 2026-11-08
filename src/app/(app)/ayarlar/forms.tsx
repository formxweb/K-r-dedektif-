"use client";

import { useActionState } from "react";
import { addMarker, bulkVatChange, closePeriod, reopenPeriod, saveOrgSettings, saveSupplier } from "@/server/settings";
import { Field, Input, Select } from "@/components/ui";
import { ConfirmDialog, FormMessage, SubmitButton } from "@/components/client";

export function OrgForm({ org }: { org: { name: string; threshold: string; dead: number; step: string } }) {
  const [state, action] = useActionState(saveOrgSettings, undefined);
  return (
    <form action={action} className="flex flex-col gap-4">
      <Field label="İşletme adı" htmlFor="name"><Input id="name" name="name" defaultValue={org.name} required /></Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Marj uyarı eşiği (puan)" htmlFor="threshold" hint="Yeni alış faturasında marj bu kadar puandan fazla düşerse uyarır.">
          <Input id="threshold" name="threshold" inputMode="decimal" defaultValue={org.threshold} required />
        </Field>
        <Field label="Ölü stok süresi (gün)" htmlFor="dead" hint="Bu kadar gündür satılmayan ürün ölü stok sayılır.">
          <Input id="dead" name="dead" inputMode="numeric" defaultValue={org.dead} required />
        </Field>
        <Field label="Fiyat yuvarlama adımı (₺)" htmlFor="step" hint="Önerilen satış fiyatı bu adıma yukarı yuvarlanır (örn. 0,50).">
          <Input id="step" name="step" inputMode="decimal" defaultValue={org.step} required />
        </Field>
      </div>
      <FormMessage state={state} />
      <div><SubmitButton pendingText="Kaydediliyor…">Değişiklikleri kaydet</SubmitButton></div>
    </form>
  );
}

export function SupplierForm({ s }: { s?: { id: string; name: string; tax_number: string | null; lead_time_days: number; order_interval_days: number; min_order_amount: string | null; phone: string | null } }) {
  const [state, action] = useActionState(saveSupplier, undefined);
  return (
    <form action={action} className="flex flex-col gap-3" key={s ? s.id : state?.message}>
      {s && <input type="hidden" name="id" value={s.id} />}
      <div className="grid gap-3 sm:grid-cols-6">
        <Field label="Ad" htmlFor={`n-${s?.id ?? "new"}`} className="sm:col-span-2"><Input id={`n-${s?.id ?? "new"}`} name="name" defaultValue={s?.name} required /></Field>
        <Field label="VKN / TCKN" htmlFor={`t-${s?.id ?? "new"}`} optional><Input id={`t-${s?.id ?? "new"}`} name="tax_number" inputMode="numeric" defaultValue={s?.tax_number ?? ""} /></Field>
        <Field label="Teslim (gün)" htmlFor={`l-${s?.id ?? "new"}`}><Input id={`l-${s?.id ?? "new"}`} name="lead_time_days" inputMode="numeric" defaultValue={s?.lead_time_days ?? 2} required /></Field>
        <Field label="Sipariş aralığı (gün)" htmlFor={`i-${s?.id ?? "new"}`}><Input id={`i-${s?.id ?? "new"}`} name="order_interval_days" inputMode="numeric" defaultValue={s?.order_interval_days ?? 7} required /></Field>
        <Field label="Min. sipariş (₺)" htmlFor={`m-${s?.id ?? "new"}`} optional><Input id={`m-${s?.id ?? "new"}`} name="min_order_amount" inputMode="decimal" defaultValue={s?.min_order_amount ?? ""} /></Field>
      </div>
      <Field label="Telefon (WhatsApp)" htmlFor={`p-${s?.id ?? "new"}`} optional className="sm:max-w-xs"><Input id={`p-${s?.id ?? "new"}`} name="phone" inputMode="tel" defaultValue={s?.phone ?? ""} /></Field>
      <FormMessage state={state} />
      <div><SubmitButton variant={s ? "secondary" : "primary"} pendingText="Kaydediliyor…">{s ? "Kaydet" : "Tedarikçi ekle"}</SubmitButton></div>
    </form>
  );
}

export function BulkVatForm({ rates, today }: { rates: string[]; today: string }) {
  const [state, action] = useActionState(bulkVatChange, undefined);
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
        <Field label="Şu an KDV'si" htmlFor="from_rate">
          <Select id="from_rate" name="from_rate" defaultValue="" required>
            <option value="" disabled>Seçin</option>
            {rates.map((r) => <option key={r} value={r}>%{r}</option>)}
          </Select>
        </Field>
        <Field label="Yeni oran" htmlFor="to_rate">
          <Select id="to_rate" name="to_rate" defaultValue="" required>
            <option value="" disabled>Seçin</option>
            <option value="0">%0</option><option value="1">%1</option><option value="10">%10</option><option value="20">%20</option>
          </Select>
        </Field>
        <Field label="Geçerlilik başlangıcı" htmlFor="vf"><Input id="vf" name="valid_from" type="date" defaultValue={today} required /></Field>
        <SubmitButton variant="secondary" pendingText="Uygulanıyor…">Toplu değiştir</SubmitButton>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

export function MarkerForm({ categories }: { categories: Array<{ id: string; name: string }> }) {
  const [state, action] = useActionState(addMarker, undefined);
  return (
    <form action={action} className="flex flex-col gap-3" key={state?.message}>
      <div className="grid gap-3 sm:grid-cols-5">
        <Field label="Dönem" htmlFor="mk_name"><Input id="mk_name" name="name" placeholder="Ramazan" required /></Field>
        <Field label="Başlangıç" htmlFor="mk_s"><Input id="mk_s" name="start_date" type="date" required /></Field>
        <Field label="Bitiş" htmlFor="mk_e"><Input id="mk_e" name="end_date" type="date" required /></Field>
        <Field label="Çarpan" htmlFor="mk_m" hint="1,3 = %30 fazla satış"><Input id="mk_m" name="multiplier" inputMode="decimal" placeholder="1,3" required /></Field>
        <Field label="Kategori" htmlFor="mk_c" optional>
          <Select id="mk_c" name="category_id" defaultValue=""><option value="">Tüm ürünler</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        </Field>
      </div>
      <FormMessage state={state} />
      <div><SubmitButton variant="secondary" pendingText="Ekleniyor…">Dönem işareti ekle</SubmitButton></div>
    </form>
  );
}

export function ClosePeriodForm({ month, label }: { month: string; label: string }) {
  const [state, action] = useActionState(closePeriod, undefined);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="month" value={month} />
      <FormMessage state={state} />
      <ConfirmDialog tone="primary" trigger={`${label} ayını kapat`} title={`${label} kapatılsın mı?`} confirmLabel="Ayı kapat"
        description="Kapalı ayın kâr tablosu bir daha değişmez. Sonradan gelen geçmiş tarihli faturaların maliyet farkı ilk açık aya ayrı satır olarak yazılır. Gerekirse yönetici ayı yeniden açabilir." />
    </form>
  );
}

export function ReopenPeriodForm({ month, label }: { month: string; label: string }) {
  const [state, action] = useActionState(reopenPeriod, undefined);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="month" value={month} />
      <FormMessage state={state} />
      <ConfirmDialog trigger={`${label} ayını yeniden aç`} title={`${label} yeniden açılsın mı?`} confirmLabel="Yeniden aç"
        description="Bu ay ve sonrasındaki kayıtlar güncel maliyet hesabına çekilir; kapalı dönem düzeltmeleri kaldırılır. Bu ayın kârı değişebilir. İşlem kayıt altına alınır." />
    </form>
  );
}
