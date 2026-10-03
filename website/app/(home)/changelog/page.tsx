import type { Metadata } from 'next';
import Link from 'next/link';
import { changelog } from '@/lib/changelog';
import { source } from '@/lib/source';
import { getMDXComponents } from '@/components/mdx';

export const metadata: Metadata = {
  title: 'Changelog',
  description: 'What changed in every hammerkit release.',
};

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

function formatDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export default function ChangelogPage() {
  const entries = [...changelog.entries].sort((a, b) => compareVersions(b.version, a.version));

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-16">
      <h1 className="text-4xl font-extrabold tracking-tight">Changelog</h1>
      <p className="mt-3 text-lg text-fd-muted-foreground">
        What changed in every release. The{' '}
        <Link href="/docs/release-blog/release-1.7.0" className="text-fd-primary hover:underline">
          release notes
        </Link>{' '}
        explain the why.
      </p>

      <div className="mt-14 flex flex-col">
        {entries.map((entry) => {
          const MDX = entry.body;
          return (
            <article
              key={entry.version}
              id={`v${entry.version}`}
              className="grid scroll-mt-24 gap-6 border-t border-fd-border py-12 md:grid-cols-[11rem_1fr]"
            >
              <div className="self-start md:sticky md:top-24">
                <a href={`#v${entry.version}`} className="font-mono text-2xl font-bold hover:text-fd-primary">
                  {entry.version}
                </a>
                {entry.date && (
                  <time dateTime={entry.date} className="mt-1 block text-sm text-fd-muted-foreground">
                    {formatDate(entry.date)}
                  </time>
                )}
                {source.getPage(['release-blog', `release-${entry.version}`]) && (
                  <Link
                    href={`/docs/release-blog/release-${entry.version}`}
                    className="mt-3 inline-block text-sm font-medium text-fd-primary hover:underline"
                  >
                    Release notes →
                  </Link>
                )}
              </div>
              <div className="prose min-w-0">
                <MDX components={getMDXComponents()} />
              </div>
            </article>
          );
        })}
      </div>
    </main>
  );
}
