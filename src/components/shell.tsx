"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Brand } from "./brand";
import { cx } from "./ui";

export interface NavItem {
  href: string;
  label: string;
  badge?: number;
  mobile?: "bar" | "menu";
}

function isActive(path: string, href: string) {
  return path === href || path.startsWith(href + "/");
}

export function AppShell({
  nav,
  orgName,
  orgSwitcher,
  userEmail,
  signOut,
  children,
}: {
  nav: NavItem[];
  orgName: string;
  orgSwitcher: ReactNode;
  userEmail: string;
  signOut: ReactNode;
  children: ReactNode;
}) {
  const path = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [path]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const bar = nav.filter((n) => n.mobile === "bar");
  return (
    <div className="min-h-dvh lg:pl-[236px]">
      {/* Masaüstü yan menü */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[236px] flex-col bg-ink-900 text-white lg:flex">
        <div className="px-5 pb-4 pt-6">
          <Link href="/genel-bakis" aria-label="Genel bakış">
            <Brand dark compact />
          </Link>
          <div className="mt-4">{orgSwitcher}</div>
        </div>
        <nav aria-label="Ana menü" className="flex-1 overflow-y-auto px-3">
          <ul className="flex flex-col gap-0.5">
            {nav.map((n) => (
              <li key={n.href}>
                <Link
                  href={n.href}
                  aria-current={isActive(path, n.href) ? "page" : undefined}
                  className={cx(
                    "flex min-h-10 items-center justify-between rounded-md px-3 text-[14px] transition-colors duration-150",
                    isActive(path, n.href) ? "bg-ink-800 font-medium text-white" : "text-ink-300 hover:bg-ink-850 hover:text-white",
                  )}
                >
                  {n.label}
                  {n.badge ? <span className="num rounded-sm bg-warn px-1.5 text-[11.5px] font-semibold text-white">{n.badge}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="border-t border-ink-800 px-5 py-4 text-[12.5px] text-ink-400">
          <p className="truncate" title={userEmail}>{userEmail}</p>
          <div className="mt-2">{signOut}</div>
        </div>
      </aside>

      {/* Mobil üst çubuk */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between bg-ink-900 px-4 text-white lg:hidden">
        <Link href="/genel-bakis" aria-label="Genel bakış"><Brand dark compact /></Link>
        <span className="max-w-[45%] truncate text-[13px] text-ink-300">{orgName}</span>
      </header>

      <main id="icerik">{children}</main>

      {/* Mobil alt menü */}
      <nav aria-label="Ana menü" className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden">
        <ul className="grid grid-cols-5">
          {bar.map((n) => (
            <li key={n.href}>
              <Link
                href={n.href}
                aria-current={isActive(path, n.href) ? "page" : undefined}
                className={cx("relative flex min-h-14 flex-col items-center justify-center px-1 text-[12px] leading-tight", isActive(path, n.href) ? "font-semibold text-text" : "text-muted")}
              >
                <span aria-hidden className={cx("absolute inset-x-4 top-0 h-[2px] rounded-b", isActive(path, n.href) ? "bg-ink-900" : "bg-transparent")} />
                {n.label}
                {n.badge ? <span className="num absolute right-2 top-1.5 rounded-sm bg-warn px-1 text-[10.5px] font-semibold text-white">{n.badge}</span> : null}
              </Link>
            </li>
          ))}
          <li>
            <button type="button" aria-expanded={menuOpen} aria-controls="mobil-menu" onClick={() => setMenuOpen((v) => !v)}
              className={cx("flex min-h-14 w-full flex-col items-center justify-center text-[12px]", menuOpen ? "font-semibold text-text" : "text-muted")}>
              Menü
            </button>
          </li>
        </ul>
      </nav>
      {menuOpen && (
        <div id="mobil-menu" className="fixed inset-0 z-20 bg-ink-950/40 lg:hidden" onClick={() => setMenuOpen(false)}>
          <div className="absolute inset-x-0 bottom-14 max-h-[75dvh] overflow-y-auto rounded-t-lg bg-surface p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] kd-enter" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3">{orgSwitcher}</div>
            <ul className="flex flex-col">
              {nav.filter((n) => n.mobile !== "bar").map((n) => (
                <li key={n.href}>
                  <Link href={n.href} className="flex min-h-12 items-center justify-between border-b border-line text-[15px]">
                    {n.label}
                    {n.badge ? <span className="num rounded-sm bg-warn px-1.5 text-[12px] font-semibold text-white">{n.badge}</span> : null}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="mt-4 flex items-center justify-between text-[13px] text-muted">
              <span className="truncate">{userEmail}</span>
              {signOut}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
