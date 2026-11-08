export interface ActionState {
  ok?: boolean;
  error?: string;
  message?: string;
  fieldErrors?: Record<string, string>;
  data?: Record<string, unknown>;
}

interface PgLikeError {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
}

/**
 * Veritabanı/servis hatasını kullanıcıya gösterilecek Türkçe mesaja çevirir.
 * İş kuralı hataları (KD*** kodları) veritabanında zaten anlaşılır Türkçe yazılır.
 */
export function friendlyError(e: unknown): string {
  const err = (e ?? {}) as PgLikeError;
  const code = err.code ?? "";
  const msg = err.message ?? (e instanceof Error ? e.message : "");
  if (code.startsWith("KD")) return msg;
  if (code === "42501") return msg && /[çğıöşüİ]/i.test(msg) ? msg : "Bu işlem için yetkiniz yok.";
  if (code === "23505") return "Bu kayıt zaten var. Aynı bilgiyi ikinci kez ekleyemezsiniz.";
  if (code === "23P01") return "Çakışan bir kayıt var (aynı tarih aralığı iki kez).";
  if (code === "23503") return "Bu kayıt başka kayıtlarda kullanıldığı için silinemez.";
  if (code === "23514" || code === "22P02" || code === "22003") return "Girilen değer geçersiz. Sayı ve tarih alanlarını kontrol edin.";
  if (code === "PGRST301" || /JWT|session/i.test(msg)) return "Oturumunuzun süresi doldu. Lütfen tekrar giriş yapın.";
  if (/fetch failed|ECONNREFUSED|network/i.test(msg)) return "Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edip tekrar deneyin.";
  if (msg && /[çğıöşüİ]/i.test(msg) && msg.length < 300) return msg;
  console.error("[kardedektifi] beklenmeyen hata", e);
  return "Beklenmeyen bir hata oluştu. Tekrar deneyin; sorun sürerse bize bildirin.";
}

/** Supabase yanıtındaki hatayı fırlatır (sunucu bileşenlerinde error.tsx yakalar). */
export function must<T>(res: { data: T | null; error: PgLikeError | null }): T {
  if (res.error) throw new Error(friendlyError(res.error));
  return res.data as T;
}
