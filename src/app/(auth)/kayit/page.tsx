"use client";

import Link from "next/link";
import { useActionState } from "react";
import { signUp } from "@/server/auth";
import { Field, Input } from "@/components/ui";
import { FormMessage, SubmitButton } from "@/components/client";

export default function SignUpPage() {
  const [state, action] = useActionState(signUp, undefined);
  if (state?.ok) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-[20px] font-semibold">E-postanızı kontrol edin</h1>
        <FormMessage state={state} />
        <Link href="/giris" className="text-[14px] text-accent hover:underline">Girişe dön</Link>
      </div>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <h1 className="text-[20px] font-semibold tracking-[-0.01em]">Hesap oluşturun</h1>
      <FormMessage state={state} />
      <Field label="Adınız" htmlFor="full_name" error={state?.fieldErrors?.full_name}>
        <Input id="full_name" name="full_name" autoComplete="name" required />
      </Field>
      <Field label="E-posta" htmlFor="email" error={state?.fieldErrors?.email}>
        <Input id="email" name="email" type="email" autoComplete="email" inputMode="email" required />
      </Field>
      <Field label="Şifre" htmlFor="password" hint="En az 8 karakter." error={state?.fieldErrors?.password}>
        <Input id="password" name="password" type="password" autoComplete="new-password" minLength={8} required />
      </Field>
      <SubmitButton pendingText="Hesap oluşturuluyor…" className="mt-1 w-full">Hesap oluştur</SubmitButton>
      <p className="text-[14px] text-muted">
        Hesabınız var mı? <Link href="/giris" className="text-accent hover:underline">Giriş yapın</Link>
      </p>
    </form>
  );
}
