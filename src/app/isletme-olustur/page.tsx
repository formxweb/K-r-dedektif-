import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getUser } from "@/lib/session";
import { Brand } from "@/components/brand";
import { CreateOrgForm } from "./form";

export const metadata: Metadata = { title: "İşletme oluştur" };

export default async function CreateOrgPage() {
  const user = await getUser();
  if (!user) redirect("/giris");
  return (
    <div className="flex min-h-dvh flex-col bg-ink-900">
      <div className="mx-auto flex w-full max-w-[480px] flex-1 flex-col justify-center px-4 py-10">
        <div className="mb-8"><Brand dark /></div>
        <div className="rounded-lg border border-ink-700 bg-surface p-5 sm:p-7 kd-enter">
          <CreateOrgForm />
        </div>
      </div>
    </div>
  );
}
