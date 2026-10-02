import Link from 'next/link';
import { ArrowRight, Bot, Gauge, Rocket } from 'lucide-react';

const roles = [
  {
    icon: Rocket,
    title: 'I’m new to hammerkit',
    links: [
      { label: 'Install and run a first task', href: '/docs/installation' },
      { label: 'Why hammerkit', href: '/docs/why-hammerkit' },
      { label: 'Concepts: src, generates, deps', href: '/docs/concepts' },
      { label: 'Tutorial: a real Node project', href: '/docs/tutorial' },
    ],
  },
  {
    icon: Gauge,
    title: 'I want to optimize my CI',
    links: [
      { label: 'Caching strategy in CI', href: '/docs/guides/ci-caching' },
      { label: 'Share one cache with agents and laptops', href: '/docs/guides/agents-and-ci' },
      { label: 'What the cache can’t see', href: '/docs/task/caching#limitations-what-the-cache-cant-see' },
      { label: 'Why did it rebuild? explain', href: '/docs/cli/explain' },
    ],
  },
  {
    icon: Bot,
    title: 'I build with coding agents',
    links: [
      { label: 'Migrate your CI with an agent', href: '/docs/llm' },
      { label: 'The guide your agent follows', href: '/docs/llm/migrate-ci' },
      { label: 'Read-only caches for sandboxes', href: '/docs/guides/agents-and-ci#who-may-write-to-the-cache' },
      { label: 'All docs as plain text: llms.txt', href: '/llms.txt' },
    ],
  },
];

export function Roles() {
  return (
    <section className="mx-auto w-full max-w-6xl px-6 py-20">
      <h2 className="mb-10 text-2xl font-bold">Where do you want to start?</h2>
      <div className="grid gap-10 md:grid-cols-3">
        {roles.map(({ icon: Icon, title, links }) => (
          <div key={title}>
            <div className="mb-4 flex items-center gap-2">
              <Icon className="size-5 text-fd-primary" />
              <h3 className="font-semibold">{title}</h3>
            </div>
            <ul className="flex flex-col divide-y divide-fd-border border-y border-fd-border">
              {links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="group flex items-center justify-between py-3 text-sm hover:text-fd-primary"
                  >
                    {link.label}
                    <ArrowRight className="size-4 opacity-0 transition group-hover:translate-x-1 group-hover:opacity-100" />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
