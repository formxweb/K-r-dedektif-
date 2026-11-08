"use client";

import { useActionState } from "react";
import { commitJob, createMissingProducts, revertJob } from "@/server/imports";
import { Field, Input, Select } from "@/components/ui";
import { ConfirmDialog, FormMessage, SubmitButton } from "@/components/client";

export function CommitForm({ jobId, version, okCount, skipped }: { jobId: string; version: string; okCount: number; skipped: number }) {
  const [state, action] = useActionState(commitJob, undefined);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="job_id" value={jobId} />
      <input type="hidden" name="ledger_version" value={version} />
      <FormMessage state={state} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingText="Kaydediliyor…" disabled={okCount === 0}>{okCount} satırı kaydet</SubmitButton>
        {skipped > 0 && <span className="text-[13px] text-warn">{skipped} satır işlenmeyecek.</span>}
      </div>
    </form>
  );
}

export function RevertForm({ jobId, version, fileName }: { jobId: string; version: string; fileName: string }) {
  const [state, action] = useActionState(revertJob, undefined);
  return (
    <form action={action} className="flex flex-col gap-3">
      <FormMessage state={state} />
      <ConfirmDialog
        trigger="Aktarımı geri al"
        title={`“${fileName}” geri alınsın mı?`}
        description="Bu aktarımın oluşturduğu stok hareketleri, satış ve fatura kayıtları iptal edilir. İşlem geçmişte iz bırakır."
        confirmLabel="Geri al"
      >
        <input type="hidden" name="job_id" value={jobId} />
        <input type="hidden" name="ledger_version" value={version} />
        <Field label="Neden geri alıyorsunuz?" htmlFor="reason" error={state?.fieldErrors?.reason}>
          <Input id="reason" name="reason" required minLength={3} placeholder="örn. yanlış tarih aralığı" />
        </Field>
      </ConfirmDialog>
    </form>
  );
}

export function MissingProductsForm({ jobId }: { jobId: string }) {
  const [state, action] = useActionState(createMissingProducts, undefined);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="job_id" value={jobId} />
      <p className="text-[14px] font-medium">Eşleşmeyen ürünleri yeni ürün olarak ekle</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="KDV oranı" htmlFor="vat_rate" hint="Hepsine uygulanır; sonra ürün ekranından değiştirilebilir.">
          <Select id="vat_rate" name="vat_rate" defaultValue="" required>
            <option value="" disabled>Seçin</option>
            <option value="1">%1</option>
            <option value="10">%10</option>
            <option value="20">%20</option>
            <option value="0">%0</option>
          </Select>
        </Field>
        <Field label="Birim" htmlFor="base_unit">
          <Select id="base_unit" name="base_unit" defaultValue="adet">
            <option value="adet">adet</option>
            <option value="kg">kg</option>
            <option value="lt">lt</option>
          </Select>
        </Field>
        <div className="flex items-end"><SubmitButton variant="secondary" pendingText="Ekleniyor…">Ürünleri ekle ve yeniden hazırla</SubmitButton></div>
      </div>
      <FormMessage state={state} />
    </form>
  );
}
