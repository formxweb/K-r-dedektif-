"use client";

import { useActionState } from "react";
import { postInvoice } from "@/server/invoices";
import { FormMessage, SubmitButton } from "@/components/client";

export function PostForm({ invoiceId, jobId, version }: { invoiceId: string; jobId: string; version: string }) {
  const [state, action] = useActionState(postInvoice, undefined);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="invoice_id" value={invoiceId} />
      <input type="hidden" name="job_id" value={jobId} />
      <input type="hidden" name="ledger_version" value={version} />
      <FormMessage state={state} />
      <div><SubmitButton pendingText="İşleniyor…">Faturayı işle</SubmitButton></div>
    </form>
  );
}
