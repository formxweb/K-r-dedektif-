import type { Metadata } from "next";
import { LoginForm } from "./form";

export const metadata: Metadata = { title: "Giriş" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ sonra?: string; hata?: string }> }) {
  const sp = await searchParams;
  return <LoginForm next={sp.sonra ?? ""} linkError={sp.hata === "baglanti"} />;
}
