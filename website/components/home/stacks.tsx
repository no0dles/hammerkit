import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

// One tile per tutorial.
const stacks = [
  { name: 'Node.js', badge: 'TS', color: '#3fa34d', tools: 'TypeScript, npm, node --test', href: '/docs/tutorials/node' },
  { name: 'Python', badge: 'Py', color: '#3b7bbf', tools: 'venv, pytest, ruff', href: '/docs/tutorials/python' },
  { name: 'Go', badge: 'Go', color: '#00a7d0', tools: 'modules, go vet, go test', href: '/docs/tutorials/go' },
  { name: 'Rust', badge: 'Rs', color: '#ce5a2a', tools: 'Cargo, cargo test', href: '/docs/tutorials/rust' },
  { name: 'Java', badge: 'Jv', color: '#5f8fbf', tools: 'Maven, JUnit', href: '/docs/tutorials/java' },
  { name: '.NET', badge: 'C#', color: '#a66bc4', tools: 'NuGet, xUnit', href: '/docs/tutorials/dotnet' },
];

export function Stacks() {
  return (
    <section className="mx-auto w-full max-w-6xl px-6 py-20">
      <h2 className="text-2xl font-bold">Start with your stack</h2>
      <p className="mt-2 max-w-2xl text-fd-muted-foreground">
        Take a small project from an empty build file to a cached CI pipeline. Every tutorial runs in hammerkit’s own
        test suite, so what you copy works.
      </p>

      <div className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {stacks.map((s) => (
          <Link
            key={s.name}
            href={s.href}
            className="group relative flex flex-col rounded-xl border border-fd-border bg-fd-card p-5 transition hover:-translate-y-0.5 hover:border-fd-primary/60 hover:shadow-lg"
          >
            <span
              className="flex size-11 items-center justify-center rounded-lg font-mono text-sm font-bold"
              style={{ background: `${s.color}22`, color: s.color }}
            >
              {s.badge}
            </span>
            <ArrowRight className="absolute right-4 top-5 size-4 text-fd-primary opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100" />
            <span className="mt-4 font-semibold">{s.name}</span>
            <span className="mt-1 text-sm text-fd-muted-foreground">{s.tools}</span>
          </Link>
        ))}
      </div>

      <p className="mt-8 border-t border-fd-border pt-6 text-sm text-fd-muted-foreground">
        Already have a pipeline?{' '}
        <Link href="/docs/guides/migrate-ci" className="font-medium text-fd-primary hover:underline">
          Let your coding agent migrate it →
        </Link>
      </p>
    </section>
  );
}
