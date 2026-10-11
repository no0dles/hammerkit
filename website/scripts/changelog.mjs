// Turns the sections of ../CHANGELOG.md (written by semantic-release on every
// release) into changelog entries, so /changelog follows the releases without
// anyone copying text. A version with a hand-written content/changelog/<version>.mdx
// keeps that entry. The generated auto-*.mdx files are not committed.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'content', 'changelog')
const heading = /^#{1,2} \[(\d+\.\d+\.\d+)\]\([^)]*\) \((\d{4}-\d{2}-\d{2})\)$/

// MDX reads `{` and `<` in prose as code: escape them outside of code spans.
const escapeMdx = (line) =>
  line
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/[{}]/g, '\\$&').replace(/</g, '&lt;')))
    .join('')

// "([abc1234](…commit/…))" after every item is noise next to the pull request link
const withoutCommitLink = (line) => line.replace(/ \(\[[0-9a-f]{7,}\]\([^)]*\)\)/g, '')

const sections = []
for (const line of readFileSync(join(root, '..', 'CHANGELOG.md'), 'utf8').split('\n')) {
  const match = heading.exec(line)
  if (match) sections.push({ version: match[1], date: match[2], lines: [] })
  else sections.at(-1)?.lines.push(line)
}

mkdirSync(dir, { recursive: true })
for (const file of readdirSync(dir)) if (file.startsWith('auto-')) rmSync(join(dir, file))

for (const { version, date, lines } of sections) {
  if (existsSync(join(dir, `${version}.mdx`))) continue
  const body = lines
    .map((line) => escapeMdx(withoutCommitLink(line)).replace(/^### /, '## '))
    .join('\n')
    .trim()
  const frontmatter = `---\ntitle: "Changelog ${version}"\nversion: "${version}"\ndate: "${date}"\n---\n`
  writeFileSync(join(dir, `auto-${version}.mdx`), `${frontmatter}${body}\n`)
}
