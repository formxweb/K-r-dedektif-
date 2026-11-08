"use client";

import Link from "next/link";
import { useActionState } from "react";
import { signIn } from "@/server/auth";
import { Field, Input } from "@/components/ui";
import { FormMessage, SubmitButton } from "@/components/client";

export function LoginForm({ next, linkError }: { next: string; linkError: boolean }) {
  const [state, action] = useActionState(signIn, undefined);
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <h1 className="text-[20px] font-semibold tracking-[-0.01em]">Giriş yapın</h1>
      {linkError && <FormMessage state={{ error: "Bağlantının süresi dolmuş veya daha önce kullanılmış. Tekrar deneyin." }} />}
      <FormMessage state={state} />
      <input type="hidden" name="sonra" value={next} />
      <Field label="E-posta" htmlFor="email" error={state?.fieldErrors?.email}>
        <Input id="email" name="email" type="email" autoComplete="email" inputMode="email" required />
      </Field>
      <Field label="Şifre" htmlFor="password" error={state?.fieldErrors?.password}>
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </Field>
      <SubmitButton pendingText="Giriş yapılıyor…" className="mt-1 w-full">Giriş yap</SubmitButton>
      <div className="flex flex-wrap justify-between gap-2 text-[14px]">
        <Link href="/sifremi-unuttum" className="text-accent hover:underline">Şifremi unuttum</Link>
        <Link href="/kayit" className="text-accent hover:underline">Hesap oluştur</Link>
      </div>
    </form>
  );
}
