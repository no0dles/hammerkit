'use client';
import { useEffect, useState } from 'react';

type Screen = 'laptop' | 'ci';
type Line = { text: string; screen: Screen; tone?: 'cmd' | 'muted' | 'ok' | 'hit' };

// A real run, replayed: the laptop builds and pushes its results to the shared
// cache, then a CI runner with an empty local cache pulls them and executes nothing.
const script: Line[] = [
  { screen: 'laptop', text: '$ hammerkit run ci', tone: 'cmd' },
  { screen: 'laptop', text: 'install  npm ci', tone: 'muted' },
  { screen: 'laptop', text: 'build    npm run build', tone: 'muted' },
  { screen: 'laptop', text: 'test     npm test', tone: 'muted' },
  { screen: 'laptop', text: '4 executed, 0 cached (0% cache hit), 3.7s total', tone: 'ok' },
  { screen: 'laptop', text: '' },
  { screen: 'laptop', text: '$ hammerkit cache push --remote shared', tone: 'cmd' },
  { screen: 'laptop', text: '• install: pushed', tone: 'ok' },
  { screen: 'laptop', text: '• build: pushed', tone: 'ok' },
  { screen: 'laptop', text: '• test: pushed', tone: 'ok' },
  { screen: 'laptop', text: '• ci: skipped', tone: 'muted' },
  { screen: 'laptop', text: '3/4 entries pushed' },
  { screen: 'laptop', text: '' },
  { screen: 'laptop', text: '$ git commit -am "Greet by name" && git push', tone: 'cmd' },
  { screen: 'ci', text: '$ hammerkit cache pull --remote shared', tone: 'cmd' },
  { screen: 'ci', text: '• install: pulled', tone: 'hit' },
  { screen: 'ci', text: '• build: pulled', tone: 'hit' },
  { screen: 'ci', text: '• test: pulled', tone: 'hit' },
  { screen: 'ci', text: '• ci: skipped', tone: 'muted' },
  { screen: 'ci', text: '3/4 entries pulled' },
  { screen: 'ci', text: '' },
  { screen: 'ci', text: '$ hammerkit run ci', tone: 'cmd' },
  { screen: 'ci', text: 'Summary:' },
  { screen: 'ci', text: '  build    cached     0ms', tone: 'hit' },
  { screen: 'ci', text: '  ci       cached     279ms', tone: 'hit' },
  { screen: 'ci', text: '  install  skipped    0ms', tone: 'muted' },
  { screen: 'ci', text: '  test     cached     0ms', tone: 'hit' },
  { screen: 'ci', text: '  0 executed, 3 cached, 1 skipped (100% cache hit)', tone: 'hit' },
];

const tones = {
  cmd: 'text-white',
  muted: 'text-white/40',
  ok: 'text-sky-300',
  hit: 'text-emerald-400',
  plain: 'text-white/80',
};

const screens: { key: Screen; label: string }[] = [
  { key: 'laptop', label: 'your laptop' },
  { key: 'ci', label: 'CI runner' },
];

export function Terminal() {
  const [shown, setShown] = useState(0);

  useEffect(() => {
    const done = shown >= script.length;
    const next = script[shown];
    // linger on the laptop's last line before switching over to CI
    const switching = next && shown > 0 && next.screen !== script[shown - 1].screen;
    const delay = done ? 4000 : switching ? 1800 : next?.tone === 'cmd' ? 900 : 220;
    const timer = setTimeout(() => setShown(done ? 0 : shown + 1), delay);
    return () => clearTimeout(timer);
  }, [shown]);

  const screen = script[Math.max(0, shown - 1)].screen;
  const lines = script.slice(0, shown).filter((line) => line.screen === screen);

  return (
    <div
      className="overflow-hidden rounded-2xl bg-zinc-950 text-left shadow-2xl ring-1 ring-white/10"
      aria-label="Your laptop runs hammerkit run ci and pushes the results to a shared cache; after the commit, CI pulls them and executes nothing"
    >
      <div className="flex items-center gap-1.5 border-b border-white/10 px-4 py-3">
        <span className="size-3 rounded-full bg-red-400/80" />
        <span className="size-3 rounded-full bg-amber-400/80" />
        <span className="size-3 rounded-full bg-emerald-400/80" />
        <div className="ml-4 flex gap-1 font-mono text-xs">
          {screens.map(({ key, label }) => (
            <span
              key={key}
              className={`rounded-md px-2 py-0.5 transition ${
                key === screen ? 'bg-white/10 text-white' : 'text-white/30'
              }`}
            >
              {label}
            </span>
          ))}
        </div>
      </div>
      <pre className="min-h-[23.5rem] overflow-x-auto px-5 py-4 font-mono text-[13px] leading-6" aria-hidden>
        {lines.map((line, i) => (
          <div key={i} className={tones[line.tone ?? 'plain']}>
            {line.text || ' '}
          </div>
        ))}
        <span className="inline-block h-4 w-2 animate-pulse bg-emerald-400 align-middle" />
      </pre>
    </div>
  );
}
