"use client";

import { useActionState } from "react";
import { runForecast } from "@/server/forecast";
import { FormMessage, SubmitButton } from "@/components/client";

export function RunForecastButton({ label = "Öneriyi hesapla" }: { label?: string }) {
  const [state, action] = useActionState(runForecast, undefined);
  return (
    <form action={action} className="flex flex-col items-start gap-2 sm:items-end">
      <SubmitButton pendingText="Hesaplanıyor…">{label}</SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}
