'use client';
import Link from 'next/link';
import { useState } from 'react';
import { DynamicCodeBlock } from 'fumadocs-ui/components/dynamic-codeblock';
import { buildFile, githubCi, gitlabBuildFile, gitlabCi } from './snippets';

const providers = [
  { key: 'github', label: 'GitHub Actions', buildFile, ci: githubCi, ciFile: '.github/workflows/ci.yml' },
  { key: 'gitlab', label: 'GitLab CI', buildFile: gitlabBuildFile, ci: gitlabCi, ciFile: '.gitlab-ci.yml' },
];

export function CiShowcase() {
  const [active, setActive] = useState(0);
  const provider = providers[active];

  return (
    <section className="border-t border-fd-border">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <div className="mb-8 inline-flex rounded-full border border-fd-border bg-fd-card p-1 text-sm" role="tablist">
          {providers.map(({ key, label }, i) => (
            <button
              key={key}
              role="tab"
              aria-selected={i === active}
              onClick={() => setActive(i)}
              className={`rounded-full px-4 py-1.5 font-medium transition ${
                i === active ? 'bg-fd-primary text-fd-primary-foreground' : 'text-fd-muted-foreground hover:text-fd-foreground'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="grid gap-10 lg:grid-cols-[1.2fr_1fr]">
          <div className="min-w-0">
            <h2 className="mb-2 text-2xl font-bold">One file for every machine</h2>
            <p className="mb-6 text-fd-muted-foreground">
              Tasks declare their image, what they read and what they produce, and a shared cache holds the results.
            </p>
            <DynamicCodeBlock lang="yaml" code={provider.buildFile} codeblock={{ title: '.hammerkit.yaml' }} />
          </div>
          <div className="min-w-0">
            <h2 className="mb-2 text-2xl font-bold">…and CI shrinks to this</h2>
            <p className="mb-6 text-fd-muted-foreground">
              Pull what’s already built, run the same command, push what’s new. Cache hits execute nothing.
            </p>
            <DynamicCodeBlock lang="yaml" code={provider.ci} codeblock={{ title: provider.ciFile }} />
            <Link href="/docs/guides/migrate-ci" className="mt-6 inline-block font-medium text-fd-primary hover:underline">
              Let an agent migrate your CI →
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
