'use client';
import { useEffect, useState } from 'react';

// A real run, replayed: the first run executes, the second is all cache hits.
const script: { text: string; tone?: 'cmd' | 'muted' | 'ok' | 'hit' }[] = [
  { text: '$ hammerkit run build', tone: 'cmd' },
  { text: 'install  npm ci', tone: 'muted' },
  { text: 'build    npm run build', tone: 'muted' },
  { text: 'Summary:' },
  { text: '  install  executed   12.4s', tone: 'ok' },
  { text: '  build    executed    4.1s', tone: 'ok' },
  { text: '  2 executed, 0 cached (0% cache hit), 16.5s total' },
  { text: '' },
  { text: '$ hammerkit run build', tone: 'cmd' },
  { text: 'Summary:' },
  { text: '  install  cached      0ms', tone: 'hit' },
  { text: '  build    cached      0ms', tone: 'hit' },
  { text: '  0 executed, 2 cached (100% cache hit), 14ms total', tone: 'hit' },
];

const tones = {
  cmd: 'text-white',
  muted: 'text-white/40',
  ok: 'text-sky-300',
  hit: 'text-emerald-400',
  plain: 'text-white/80',
};

export function Terminal() {
  const [shown, setShown] = useState(0);

  useEffect(() => {
    const done = shown >= script.length;
    const delay = done ? 3500 : script[shown]?.tone === 'cmd' ? 900 : 260;
    const timer = setTimeout(() => setShown(done ? 0 : shown + 1), delay);
    return () => clearTimeout(timer);
  }, [shown]);

  return (
    <div
      className="overflow-hidden rounded-2xl bg-zinc-950 text-left shadow-2xl ring-1 ring-white/10"
      aria-label="hammerkit run build, executed once and then cached"
    >
      <div className="flex gap-1.5 border-b border-white/10 px-4 py-3">
        <span className="size-3 rounded-full bg-red-400/80" />
        <span className="size-3 rounded-full bg-amber-400/80" />
        <span className="size-3 rounded-full bg-emerald-400/80" />
      </div>
      <pre className="min-h-[21rem] px-5 py-4 font-mono text-[13px] leading-6" aria-hidden>
        {script.slice(0, shown).map((line, i) => (
          <div key={i} className={tones[line.tone ?? 'plain']}>
            {line.text || ' '}
          </div>
        ))}
        <span className="inline-block h-4 w-2 animate-pulse bg-emerald-400 align-middle" />
      </pre>
    </div>
  );
}
