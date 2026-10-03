import Link from 'next/link';
import { Bot, Container, DatabaseZap, Workflow } from 'lucide-react';
import { Terminal } from '@/components/home/terminal';
import { Stacks } from '@/components/home/stacks';
import { installCommand } from '@/components/home/snippets';
import { CiShowcase } from '@/components/home/ci-showcase';

const features = [
  { icon: Container, title: 'Same tools everywhere', text: 'Every task runs in the image it names. No “works on my machine”.' },
  { icon: DatabaseZap, title: 'Skips what didn’t change', text: 'A task reruns only when a file it reads changes — locally and in CI.' },
  { icon: Workflow, title: 'Shared across machines', text: 'Laptops, CI runners and agent sandboxes reuse each other’s results.' },
  { icon: Bot, title: 'Agent-ready', text: 'Hand your coding agent the migration guide and it rewrites your CI.' },
];

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-x-0 -top-40 mx-auto h-96 max-w-3xl rounded-full bg-emerald-500/25 blur-3xl" />
        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-6 pb-20 pt-20 lg:grid-cols-2 xl:grid-cols-[1.15fr_1fr]">
          <div>
            <Link
              href="/changelog"
              className="mb-4 inline-flex rounded-full border border-fd-border bg-fd-card px-3 py-1 text-xs font-medium text-fd-muted-foreground hover:text-fd-foreground"
            >
              New in 1.7: agent-ready caching →
            </Link>
            <h1 className="text-5xl font-extrabold tracking-tight sm:text-6xl lg:text-5xl xl:text-6xl">
              Build once.
              <br />
              <span className="bg-gradient-to-r from-emerald-500 to-teal-400 bg-clip-text text-transparent">
                Reuse everywhere.
              </span>
            </h1>
            <p className="mt-6 max-w-lg text-lg text-fd-muted-foreground">
              hammerkit runs your build in containers, on your laptop and in CI alike, and skips every task whose
              inputs didn’t change — wherever it ran first.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href="/docs/installation"
                className="rounded-full bg-fd-primary px-6 py-3 font-semibold text-fd-primary-foreground shadow hover:opacity-90"
              >
                Get started
              </Link>
              <code className="rounded-full border border-fd-border bg-fd-card px-4 py-2.5 font-mono text-sm">
                {installCommand}
              </code>
            </div>
          </div>
          <Terminal />
        </div>
      </section>

      <section className="border-y border-fd-border bg-fd-card/50">
        <div className="mx-auto grid max-w-6xl gap-px px-6 py-14 sm:grid-cols-2 lg:grid-cols-4">
          {features.map(({ icon: Icon, title, text }) => (
            <div key={title} className="p-4">
              <Icon className="mb-3 size-6 text-fd-primary" />
              <h3 className="font-semibold">{title}</h3>
              <p className="mt-1 text-sm text-fd-muted-foreground">{text}</p>
            </div>
          ))}
        </div>
      </section>

      <Stacks />

      <CiShowcase />
    </main>
  );
}
