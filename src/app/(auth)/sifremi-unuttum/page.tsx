"use client";

import Link from "next/link";
import { useActionState } from "react";
import { requestPasswordReset } from "@/server/auth";
import { Field, Input } from "@/components/ui";
import { FormMessage, SubmitButton } from "@/components/client";

export default function ForgotPage() {
  const [state, action] = useActionState(requestPasswordReset, undefined);
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <h1 className="text-[20px] font-semibold tracking-[-0.01em]">Şifrenizi sıfırlayın</h1>
      <p className="text-[14px] text-muted">Hesabınızın e-posta adresini yazın; şifre yenileme bağlantısı gönderelim.</p>
      <FormMessage state={state} />
      {!state?.ok && (
        <>
          <Field label="E-posta" htmlFor="email" error={state?.fieldErrors?.email}>
            <Input id="email" name="email" type="email" autoComplete="email" inputMode="email" required />
          </Field>
          <SubmitButton pendingText="Gönderiliyor…" className="w-full">Bağlantı gönder</SubmitButton>
        </>
      )}
      <Link href="/giris" className="text-[14px] text-accent hover:underline">Girişe dön</Link>
    </form>
  );
}
