import { cx } from "./ui";

/** Yazı tabanlı marka: dekoratif ikon yok. */
export function Brand({ dark, compact }: { dark?: boolean; compact?: boolean }) {
  return (
    <span className={cx("inline-flex items-baseline font-semibold tracking-[-0.03em]", compact ? "text-[17px]" : "text-[22px]", dark ? "text-white" : "text-text")}>
      Kâr<span className={dark ? "text-ink-300" : "text-muted"}>Dedektifi</span>
    </span>
  );
}
