import type { ReactNode } from "react";
import { Brand } from "@/components/brand";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-ink-900">
      <div className="mx-auto flex w-full max-w-[440px] flex-1 flex-col justify-center px-4 py-10">
        <div className="mb-8">
          <Brand dark />
          <p className="mt-3 text-[15px] leading-relaxed text-ink-300">
            Giderlerden sonra gerçekte ne kazandığınızı, hangi ürünün kaybettirdiğini ve ne kadar sipariş vermeniz gerektiğini gösterir.
          </p>
        </div>
        <div className="rounded-lg border border-ink-700 bg-surface p-5 sm:p-7 kd-enter">{children}</div>
      </div>
    </div>
  );
}
