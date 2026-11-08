"use client";

import { useActionState } from "react";
import { createOrganization, signOut } from "@/server/auth";
import { Field, Input } from "@/components/ui";
import { FormMessage, SubmitButton } from "@/components/client";

export function CreateOrgForm() {
  const [state, action] = useActionState(createOrganization, undefined);
  return (
    <div className="flex flex-col gap-4">
      <form action={action} className="flex flex-col gap-4" noValidate>
        <h1 className="text-[20px] font-semibold tracking-[-0.01em]">İşletmenizi oluşturun</h1>
        <p className="text-[14px] leading-relaxed text-muted">
          Sonraki adımda POS programınızdan aldığınız ürün listesini ve satış raporunu yükleyeceksiniz.
        </p>
        <FormMessage state={state} />
        <Field label="İşletme adı" htmlFor="name" hint="Örn. Yıldız Market" error={state?.fieldErrors?.name}>
          <Input id="name" name="name" autoComplete="organization" required />
        </Field>
        <SubmitButton pendingText="Oluşturuluyor…" className="w-full">İşletmeyi oluştur</SubmitButton>
      </form>
      <form action={signOut}>
        <button className="text-[14px] text-accent hover:underline">Farklı hesapla giriş yap</button>
      </form>
    </div>
  );
}
