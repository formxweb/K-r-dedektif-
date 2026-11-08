"use client";

import { Page, Callout } from "@/components/ui";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Page width="narrow">
      <Callout tone="neg" title="Bu sayfa yüklenemedi" action={<button onClick={reset} className="min-h-10 rounded-md border border-line-strong px-3 text-[14px]">Tekrar dene</button>}>
        {error.message && !/server components render/i.test(error.message) ? error.message : "Beklenmeyen bir hata oluştu. Tekrar deneyin; sorun sürerse bize bildirin."}
      </Callout>
    </Page>
  );
}
