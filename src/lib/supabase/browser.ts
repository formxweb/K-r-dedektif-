"use client";

import { createClient } from "@supabase/supabase-js";

/**
 * Tarayıcıdaki Supabase istemcisi — sadece sunucunun verdiği imzalı adrese dosya
 * yüklemek için. Oturum tutmaz; veri okuma/yazma sunucu tarafında yapılır.
 */
let client: ReturnType<typeof createClient> | null = null;

export function browserStorage() {
  if (!client) {
    client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return client.storage.from("imports");
}
