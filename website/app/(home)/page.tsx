import Link from 'next/link';
import { BeforeAfter } from '@/components/home/before-after';
import { features } from '@/components/home/features';
import { Stacks } from '@/components/home/stacks';
import { installCommand } from '@/components/home/snippets';
import { CiShowcase } from '@/components/home/ci-showcase';

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-x-0 -top-40 mx-auto h-96 max-w-3xl rounded-full bg-emerald-500/25 blur-3xl" />
        <div className="relative mx-auto flex max-w-3xl flex-col items-center px-6 pb-20 pt-24 text-center">
          <Link
            href="/changelog#v1.8.0"
            className="mb-4 inline-flex rounded-full border border-fd-border bg-fd-card px-3 py-1 text-xs font-medium text-fd-muted-foreground hover:text-fd-foreground"
          >
            New in 1.8: tutorials for six languages →
          </Link>
          <h1 className="text-5xl font-extrabold tracking-tight sm:text-6xl">
            Wait less.
            <br />
            <span className="bg-gradient-to-r from-emerald-500 to-teal-400 bg-clip-text text-transparent">
              Build more.
            </span>
          </h1>
          <p className="mt-6 max-w-xl text-lg text-fd-muted-foreground">
            Agentic development needs new tools to scale. hammerkit keeps your secrets safe and your agents in check,
            and spends compute only on work that hasn’t been done yet.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
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
      </section>

      {features.map(({ key, icon: Icon, title, text, links, experimental }, i) => (
        <section key={key} className="border-t border-fd-border">
          <div className="mx-auto grid max-w-6xl items-center gap-10 px-6 py-20 lg:grid-cols-2 lg:gap-16">
            <div className={i % 2 === 1 ? 'lg:order-2' : undefined}>
              <Icon className="mb-4 size-8 text-fd-primary" />
              <h2 className="text-3xl font-bold tracking-tight">
                {title}
                {experimental && (
                  <span className="ml-3 inline-block -translate-y-1 rounded-full border border-fd-border px-2 py-0.5 align-middle text-xs font-medium tracking-normal text-fd-muted-foreground">
                    experimental
                  </span>
                )}
              </h2>
              <p className="mt-4 max-w-lg text-lg text-fd-muted-foreground">{text}</p>
              <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-2">
                {links.map(({ label, href }) => (
                  <li key={href}>
                    <Link href={href} className="font-medium text-fd-primary hover:underline">
                      {label} →
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
            <BeforeAfter scene={key} />
          </div>
        </section>
      ))}

      <div className="border-t border-fd-border">
        <Stacks />
      </div>

      <CiShowcase />
    </main>
  );
}
