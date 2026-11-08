"use client";

import { useActionState } from "react";
import { addExpense, addRebate, addRecurring } from "@/server/expenses";
import { Field, Input, Select } from "@/components/ui";
import { FormMessage, SubmitButton } from "@/components/client";

type Cat = { id: string; name: string };

export function ExpenseForm({ categories, ym }: { categories: Cat[]; ym: string }) {
  const [state, action] = useActionState(addExpense, undefined);
  return (
    <form action={action} className="flex flex-col gap-3" key={state?.message}>
      <input type="hidden" name="month" value={ym} />
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_1.4fr]">
        <Field label="Kategori" htmlFor="category_id">
          <Select id="category_id" name="category_id" required defaultValue="">
            <option value="" disabled>Seçin</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Tutar (KDV hariç)" htmlFor="amount" error={state?.fieldErrors?.amount} hint="Kâr tablosuna giren tutar.">
          <Input id="amount" name="amount" inputMode="decimal" placeholder="12.500,00" required />
        </Field>
        <Field label="KDV" htmlFor="vat_amount" optional hint="İndirilebilir KDV; kâra girmez.">
          <Input id="vat_amount" name="vat_amount" inputMode="decimal" />
        </Field>
        <Field label="Açıklama" htmlFor="description" optional><Input id="description" name="description" maxLength={200} /></Field>
      </div>
      <FormMessage state={state} />
      <div><SubmitButton pendingText="Ekleniyor…">Gideri ekle</SubmitButton></div>
    </form>
  );
}

export function RecurringForm({ categories, ym }: { categories: Cat[]; ym: string }) {
  const [state, action] = useActionState(addRecurring, undefined);
  return (
    <form action={action} className="flex flex-col gap-3" key={state?.message}>
      <div className="grid gap-3 sm:grid-cols-5">
        <Field label="Kategori" htmlFor="r_category">
          <Select id="r_category" name="category_id" required defaultValue="">
            <option value="" disabled>Seçin</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Açıklama" htmlFor="r_description" error={state?.fieldErrors?.description}><Input id="r_description" name="description" placeholder="Dükkan kirası" required /></Field>
        <Field label="Aylık tutar (KDV hariç)" htmlFor="r_amount"><Input id="r_amount" name="amount" inputMode="decimal" required /></Field>
        <Field label="KDV" htmlFor="r_vat" optional><Input id="r_vat" name="vat_amount" inputMode="decimal" /></Field>
        <Field label="Başlangıç ayı" htmlFor="r_start"><Input id="r_start" name="start_month" type="month" defaultValue={ym} required /></Field>
      </div>
      <FormMessage state={state} />
      <div><SubmitButton variant="secondary" pendingText="Ekleniyor…">Tekrarlayan gider ekle</SubmitButton></div>
    </form>
  );
}

export function RebateForm({ suppliers, ym }: { suppliers: Cat[]; ym: string }) {
  const [state, action] = useActionState(addRebate, undefined);
  if (suppliers.length === 0) return <p className="text-[14px] text-muted">Tedarikçi primi girmek için önce tedarikçi olmalı (fatura yüklenince otomatik eklenir).</p>;
  return (
    <form action={action} className="flex flex-col gap-3" key={state?.message}>
      <input type="hidden" name="month" value={ym} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Tedarikçi" htmlFor="b_supplier">
          <Select id="b_supplier" name="supplier_id" required defaultValue="">
            <option value="" disabled>Seçin</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="Prim tutarı (KDV hariç)" htmlFor="b_amount"><Input id="b_amount" name="amount" inputMode="decimal" required /></Field>
        <Field label="Açıklama" htmlFor="b_description" optional><Input id="b_description" name="description" placeholder="Ekim ciro primi" /></Field>
      </div>
      <FormMessage state={state} />
      <div><SubmitButton variant="secondary" pendingText="Ekleniyor…">Primi ekle</SubmitButton></div>
    </form>
  );
}
