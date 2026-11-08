import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { env } from "@/lib/env";

/** Kullanıcının oturumuyla çalışan Supabase istemcisi. Tüm sorgular RLS altındadır. */
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(env.supabaseUrl, env.supabaseKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Server Component içinden çağrıldıysa yazılamaz; proxy oturumu yeniler.
        }
      },
    },
  });
}

export type Supa = Awaited<ReturnType<typeof createClient>>;
