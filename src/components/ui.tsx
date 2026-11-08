import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { dec, type DecInput } from "@/lib/domain/decimal";
import { formatPct, formatQty, formatSignedPct, formatTL } from "@/lib/domain/format";

export function cx(...c: Array<string | false | null | undefined>): string {
  return c.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Sayfa iskeleti
// ---------------------------------------------------------------------------
export function Page({ children, width = "default" }: { children: ReactNode; width?: "default" | "narrow" | "wide" }) {
  const max = width === "narrow" ? "max-w-[680px]" : width === "wide" ? "max-w-[1320px]" : "max-w-[1180px]";
  return <div className={cx("mx-auto w-full px-4 pb-28 pt-5 sm:px-6 lg:pb-12 lg:pt-8 kd-enter", max)}>{children}</div>;
}

export function PageHeader({
  title,
  description,
  actions,
  crumbs,
  meta,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  crumbs?: Array<{ href: string; label: string }>;
  meta?: ReactNode;
}) {
  return (
    <header className="mb-6">
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Konum" className="mb-2 flex flex-wrap items-center gap-1 text-[13px] text-muted">
          {crumbs.map((c, i) => (
            <span key={c.href} className="flex items-center gap-1">
              {i > 0 && <span aria-hidden className="text-faint">›</span>}
              <Link href={c.href} className="hover:text-text hover:underline">
                {c.label}
              </Link>
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.02em] text-text sm:text-[30px]">{title}</h1>
          {description && <p className="mt-1.5 max-w-[62ch] text-[15px] leading-relaxed text-muted">{description}</p>}
          {meta && <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">{meta}</div>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export function Section({ title, description, actions, children, id }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="mt-8 first:mt-0">
      {(title || actions) && (
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            {title && <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-text">{title}</h2>}
            {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** L1 yüzey: beyaz, ince çizgi. Kart yığını yerine tek çerçeve. */
export function Panel({ children, className, padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return <div className={cx("rounded-md border border-line bg-surface", padded && "p-4 sm:p-5", className)}>{children}</div>;
}

// ---------------------------------------------------------------------------
// Düğmeler ve form alanları
// ---------------------------------------------------------------------------
type Variant = "primary" | "secondary" | "ghost" | "danger";
const btnBase =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-md px-3.5 text-[14px] font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60 whitespace-nowrap";
const btnVariant: Record<Variant, string> = {
  primary: "bg-ink-900 text-white hover:bg-ink-800 active:bg-ink-950",
  secondary: "border border-line-strong bg-surface text-text hover:bg-subtle",
  ghost: "text-text hover:bg-ink-200/40",
  danger: "bg-neg text-white hover:bg-[#9b1f17]",
};

export function buttonClass(variant: Variant = "secondary", extra?: string) {
  return cx(btnBase, btnVariant[variant], extra);
}

export function Button({ variant = "secondary", className, ...props }: ComponentProps<"button"> & { variant?: Variant }) {
  return <button {...props} className={buttonClass(variant, className)} />;
}

export function LinkButton({ variant = "secondary", className, ...props }: ComponentProps<typeof Link> & { variant?: Variant }) {
  return <Link {...props} className={buttonClass(variant, className)} />;
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  optional,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-text">
        {label}
        {optional && <span className="ml-1 font-normal text-faint">(isteğe bağlı)</span>}
      </label>
      {children}
      {error ? (
        <p className="text-[13px] text-neg" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[12.5px] leading-snug text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

const inputBase =
  "min-h-10 w-full rounded-md border border-line-strong bg-surface px-3 text-[15px] text-text placeholder:text-faint transition-colors duration-150 hover:border-ink-400 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:bg-subtle";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input {...props} className={cx(inputBase, className)} />;
}

export function Select({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <select {...props} className={cx(inputBase, "appearance-none bg-[length:16px] bg-[right_10px_center] bg-no-repeat pr-9", className)}
      style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='%235a6476'%3E%3Cpath d='M5.5 7.5 10 12l4.5-4.5'/%3E%3C/svg%3E\")" }}>
      {children}
    </select>
  );
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea {...props} className={cx(inputBase, "min-h-20 py-2", className)} />;
}

// ---------------------------------------------------------------------------
// Göstergeler
// ---------------------------------------------------------------------------
type Tone = "neutral" | "pos" | "neg" | "warn" | "info" | "dark";
const toneClass: Record<Tone, string> = {
  neutral: "bg-subtle text-muted border-line",
  pos: "bg-pos-soft text-pos border-pos/15",
  neg: "bg-neg-soft text-neg border-neg/15",
  warn: "bg-warn-soft text-warn border-warn/20",
  info: "bg-accent-soft text-accent border-accent/15",
  dark: "bg-ink-900 text-white border-ink-900",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={cx("inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[12px] font-medium leading-none whitespace-nowrap", toneClass[tone])}>
      {children}
    </span>
  );
}

export function Callout({ tone = "info", title, children, action }: { tone?: Exclude<Tone, "dark">; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const border = { neutral: "border-line", pos: "border-pos/25", neg: "border-neg/25", warn: "border-warn/30", info: "border-accent/20" }[tone];
  const bar = { neutral: "bg-ink-400", pos: "bg-pos", neg: "bg-neg", warn: "bg-warn", info: "bg-accent" }[tone];
  return (
    <div className={cx("relative flex flex-col gap-2 overflow-hidden rounded-md border bg-surface py-3 pl-4 pr-3 sm:flex-row sm:items-center sm:justify-between", border)} role={tone === "neg" ? "alert" : undefined}>
      <span aria-hidden className={cx("absolute inset-y-0 left-0 w-[3px]", bar)} />
      <div className="text-[14px] leading-relaxed">
        {title && <p className="font-medium text-text">{title}</p>}
        {children && <div className="text-muted">{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** Para: 12.450,75 ₺. tone="auto" ise kâr yeşil, zarar kırmızı. */
export function Money({ value, tone, className, decimals = 2 }: { value: DecInput | null | undefined; tone?: "auto" | "none"; className?: string; decimals?: number }) {
  const t = tone === "auto" && value !== null && value !== undefined && value !== "" ? (dec(value).isNegative() ? "text-neg" : dec(value).isZero() ? "" : "text-pos") : "";
  return <span className={cx("num whitespace-nowrap", t, className)}>{formatTL(value, decimals)}</span>;
}

export function Qty({ value, unit, className }: { value: DecInput | null | undefined; unit?: string; className?: string }) {
  return <span className={cx("num whitespace-nowrap", className)}>{formatQty(value, unit)}</span>;
}

export function Pct({ value, signed, tone, className, decimals = 1 }: { value: DecInput | null | undefined; signed?: boolean; tone?: "auto" | "none"; className?: string; decimals?: number }) {
  const t = tone === "auto" && value !== null && value !== undefined ? (dec(value).isNegative() ? "text-neg" : "text-pos") : "";
  return <span className={cx("num whitespace-nowrap", t, className)}>{signed ? formatSignedPct(value, decimals) : formatPct(value, decimals)}</span>;
}

/** Genel bakış rakam kutusu */
export function Stat({ label, hint, value, sub, tone }: { label: string; hint?: string; value: ReactNode; sub?: ReactNode; tone?: "pos" | "neg" | null }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 bg-surface p-4">
      <div className="text-[13px] font-medium text-muted">
        {label}
        {hint && <span className="block text-[12px] font-normal text-faint">{hint}</span>}
      </div>
      <div className={cx("num text-[22px] font-semibold tracking-[-0.02em] sm:text-[24px]", tone === "pos" && "text-pos", tone === "neg" && "text-neg")}>{value}</div>
      {sub && <div className="text-[12.5px] text-muted">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tablo
// ---------------------------------------------------------------------------
export function TableFrame({ children, toolbar, footer }: { children: ReactNode; toolbar?: ReactNode; footer?: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-md border border-line bg-surface">
      {toolbar && <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">{toolbar}</div>}
      <div className="overflow-x-auto">{children}</div>
      {footer && <div className="border-t border-line px-3 py-2.5">{footer}</div>}
    </div>
  );
}

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return <table className={cx("w-full border-collapse text-[14px]", className)}>{children}</table>;
}

export function Th({ children, align = "left", className }: { children?: ReactNode; align?: "left" | "right" | "center"; className?: string }) {
  return (
    <th scope="col" className={cx("sticky top-0 whitespace-nowrap border-b border-line bg-subtle px-3 py-2.5 text-[12.5px] font-medium text-muted", align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left", className)}>
      {children}
    </th>
  );
}

export function Td({ children, align = "left", className, colSpan }: { children?: ReactNode; align?: "left" | "right" | "center"; className?: string; colSpan?: number }) {
  return (
    <td colSpan={colSpan} className={cx("border-b border-line px-3 py-2.5 align-middle", align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left", className)}>
      {children}
    </td>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 px-5 py-10 sm:items-center sm:text-center">
      <p className="text-[16px] font-semibold text-text">{title}</p>
      {children && <div className="max-w-[52ch] text-[14px] leading-relaxed text-muted">{children}</div>}
      {action}
    </div>
  );
}

export function Pagination({ page, pageSize, total, hrefFor }: { page: number; pageSize: number; total: number; hrefFor: (p: number) => string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const prev = page > 1;
  const next = page < pages;
  const cls = "inline-flex min-h-9 items-center rounded-md border border-line-strong px-3 text-[13px]";
  return (
    <div className="flex items-center justify-between gap-3 text-[13px] text-muted">
      <span className="num">
        {from}–{to} / {total}
      </span>
      <div className="flex items-center gap-2">
        {prev ? <Link className={cx(cls, "text-text hover:bg-subtle")} href={hrefFor(page - 1)}>Önceki</Link> : <span className={cx(cls, "text-faint")} aria-disabled>Önceki</span>}
        <span className="num">{page} / {pages}</span>
        {next ? <Link className={cx(cls, "text-text hover:bg-subtle")} href={hrefFor(page + 1)}>Sonraki</Link> : <span className={cx(cls, "text-faint")} aria-disabled>Sonraki</span>}
      </div>
    </div>
  );
}

export function Tabs({ items, current }: { items: Array<{ key: string; label: string; href: string; count?: number }>; current: string }) {
  return (
    <nav aria-label="Bölümler" className="-mx-4 mb-5 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
      <ul className="flex gap-5 whitespace-nowrap">
        {items.map((t) => (
          <li key={t.key}>
            <Link
              href={t.href}
              aria-current={t.key === current ? "page" : undefined}
              className={cx(
                "-mb-px inline-flex min-h-10 items-center gap-1.5 border-b-2 text-[14px] transition-colors duration-150",
                t.key === current ? "border-ink-900 font-medium text-text" : "border-transparent text-muted hover:text-text",
              )}
            >
              {t.label}
              {t.count !== undefined && <span className="num rounded-sm bg-subtle px-1 text-[12px] text-muted">{t.count}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function DefList({ items }: { items: Array<{ label: string; value: ReactNode; hint?: string }> }) {
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-3 lg:grid-cols-6">
      {items.map((i) => (
        <div key={i.label} className="bg-surface p-3">
          <dt className="text-[12.5px] text-muted">{i.label}</dt>
          <dd className="num mt-0.5 text-[16px] font-semibold text-text">{i.value}</dd>
          {i.hint && <dd className="mt-0.5 text-[12px] text-faint">{i.hint}</dd>}
        </div>
      ))}
    </dl>
  );
}

export const NOTE_MGMT = "Bu tablo yönetim amaçlıdır, resmî mali tablo yerine geçmez.";
