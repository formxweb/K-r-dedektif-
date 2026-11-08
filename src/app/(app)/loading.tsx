export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-[1180px] px-4 pt-6 sm:px-6 lg:pt-8" aria-busy="true" aria-label="Yükleniyor">
      <div className="h-8 w-56 animate-pulse rounded-md bg-ink-200/60" />
      <div className="mt-3 h-4 w-80 max-w-full animate-pulse rounded bg-ink-200/50" />
      <div className="mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-24 bg-surface p-4"><div className="h-3 w-20 animate-pulse rounded bg-ink-200/60" /><div className="mt-4 h-6 w-28 animate-pulse rounded bg-ink-200/60" /></div>
        ))}
      </div>
      <div className="mt-6 h-64 animate-pulse rounded-md border border-line bg-surface" />
    </div>
  );
}
