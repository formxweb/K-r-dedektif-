"use client";

import { useActionState } from "react";
import { updatePassword } from "@/server/auth";
import { Field, Input } from "@/components/ui";
import { FormMessage, SubmitButton } from "@/components/client";
import { Brand } from "@/components/brand";

export default function ResetPage() {
  const [state, action] = useActionState(updatePassword, undefined);
  return (
    <div className="flex min-h-dvh flex-col bg-ink-900">
      <div className="mx-auto flex w-full max-w-[440px] flex-1 flex-col justify-center px-4 py-10">
        <div className="mb-8"><Brand dark /></div>
        <form action={action} className="flex flex-col gap-4 rounded-lg border border-ink-700 bg-surface p-5 sm:p-7" noValidate>
          <h1 className="text-[20px] font-semibold">Yeni şifre belirleyin</h1>
          <FormMessage state={state} />
          <Field label="Yeni şifre" htmlFor="password" hint="En az 8 karakter." error={state?.fieldErrors?.password}>
            <Input id="password" name="password" type="password" autoComplete="new-password" required />
          </Field>
          <Field label="Yeni şifre (tekrar)" htmlFor="password2" error={state?.fieldErrors?.password2}>
            <Input id="password2" name="password2" type="password" autoComplete="new-password" required />
          </Field>
          <SubmitButton pendingText="Kaydediliyor…" className="w-full">Şifreyi kaydet</SubmitButton>
        </form>
      </div>
    </div>
  );
}
