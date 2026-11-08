"use client";

import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { buttonClass, cx } from "./ui";
import type { ActionState } from "@/lib/errors";

/** Gönderim sırasında "…" gösteren düğme. Her zaman tıklanabilir (forms kuralı); çift gönderimi engeller. */
export function SubmitButton({
  children,
  pendingText,
  variant = "primary",
  className,
  ...props
}: ComponentProps<"button"> & { pendingText?: string; variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  const { pending } = useFormStatus();
  return (
    <button
      {...props}
      type="submit"
      aria-disabled={pending}
      onClick={(e) => {
        if (pending) e.preventDefault();
        props.onClick?.(e);
      }}
      className={buttonClass(variant, cx(pending && "opacity-70", className))}
    >
      {pending ? (
        <>
          <span aria-hidden className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" />
          {pendingText ?? "İşleniyor…"}
        </>
      ) : (
        children
      )}
    </button>
  );
}

export function FormMessage({ state }: { state: ActionState | undefined | null }) {
  if (!state) return null;
  if (state.error)
    return (
      <p role="alert" className="rounded-md border border-neg/20 bg-neg-soft px-3 py-2 text-[14px] text-neg">
        {state.error}
      </p>
    );
  if (state.message)
    return (
      <p role="status" className="rounded-md border border-pos/20 bg-pos-soft px-3 py-2 text-[14px] text-pos">
        {state.message}
      </p>
    );
  return null;
}

/**
 * Yıkıcı işlem onayı: kullanıcı işlemi adıyla görür, gerekirse neden yazar.
 * Form, onay verilince gönderilir.
 */
export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  children,
  tone = "danger",
}: {
  trigger: ReactNode;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  /** form içeriği (gizli alanlar, neden alanı vb.) */
  children?: ReactNode;
  tone?: "danger" | "primary";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button type="button" ref={opener} className={buttonClass(tone === "danger" ? "secondary" : "primary", tone === "danger" ? "text-neg" : "")} onClick={() => ref.current?.showModal()}>
        {trigger}
      </button>
      <dialog
        ref={ref}
        onClose={() => opener.current?.focus()}
        className="m-auto w-[min(92vw,460px)] rounded-lg border border-line bg-surface p-0 text-text shadow-[0_12px_40px_rgba(8,17,31,0.25)] backdrop:bg-ink-950/50"
      >
        <div className="p-5">
          <h2 className="text-[17px] font-semibold">{title}</h2>
          {description && <div className="mt-2 text-[14px] leading-relaxed text-muted">{description}</div>}
          <div className="mt-4 flex flex-col gap-3">{children}</div>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className={buttonClass("secondary")} onClick={() => ref.current?.close()}>
              Vazgeç
            </button>
            <SubmitButton variant={tone === "danger" ? "danger" : "primary"}>{confirmLabel}</SubmitButton>
          </div>
        </div>
      </dialog>
    </>
  );
}

export function CopyButton({ text, label = "Kopyala", copiedLabel = "Kopyalandı" }: { text: string; label?: string; copiedLabel?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className={buttonClass("secondary")}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          window.prompt("Metni kopyalayın:", text);
        }
      }}
    >
      <span aria-live="polite">{copied ? copiedLabel : label}</span>
    </button>
  );
}

/** Seçim değişince formu gönderir (ay seçici vb.) */
export function AutoSubmitSelect({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <select
      {...props}
      className={cx("min-h-10 rounded-md border border-line-strong bg-surface px-3 text-[14px]", className)}
      onChange={(e) => {
        props.onChange?.(e);
        e.currentTarget.form?.requestSubmit();
      }}
    >
      {children}
    </select>
  );
}

/** Kaydedilmemiş değişiklik varken sayfadan çıkmayı uyarır. */
export function DirtyGuard({ formId }: { formId: string }) {
  useEffect(() => {
    const form = document.getElementById(formId) as HTMLFormElement | null;
    if (!form) return;
    let dirty = false;
    const mark = () => (dirty = true);
    const clear = () => (dirty = false);
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    form.addEventListener("input", mark);
    form.addEventListener("submit", clear);
    window.addEventListener("beforeunload", warn);
    return () => {
      form.removeEventListener("input", mark);
      form.removeEventListener("submit", clear);
      window.removeEventListener("beforeunload", warn);
    };
  }, [formId]);
  return null;
}
