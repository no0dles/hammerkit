// One-time migration of the GitBook docs (../docs) into the site's MDX content:
// pages go to content/docs, release changelogs to content/changelog. Re-run with
// `npm run convert` while docs/ is still the source; afterwards edit content/.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, posix } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const site = join(here, '..')
const repo = join(site, '..')
const docs = join(repo, 'docs')
// the repo root already depends on `yaml`
const { parse: parseYaml } = createRequire(join(repo, 'package.json'))('yaml')

// pages written by hand in content/docs; links to their sources still resolve
const handwritten = new Set(['installation.md'])

// sidebar icons (lucide names), by page or folder
const icons = {
  'why-hammerkit.md': 'Lightbulb',
  'getting-started.md': 'Play',
  'tutorial.md': 'GraduationCap',
  'concepts.md': 'Boxes',
  'recipes.md': 'CookingPot',
  'faq.md': 'CircleHelp',
  'build-file': 'FileCode',
  task: 'Hammer',
  service: 'Database',
  labels: 'Tags',
  guides: 'Map',
  llm: 'Bot',
  cli: 'Terminal',
  'release-blog': 'Newspaper',
  contribution: 'GitPullRequest',
  adr: 'Scale',
}

const calloutTypes = { info: 'info', warning: 'warn', success: 'success', danger: 'error' }
const jsxLine = /^\s*<\/?(Callout|Tabs|Tab|Cards|Card)\b/

function walk(dir, base = '') {
  return readdirSync(join(dir, base)).flatMap((name) => {
    const rel = posix.join(base, name)
    return statSync(join(dir, rel)).isDirectory() ? walk(dir, rel) : [rel]
  })
}

const sources = walk(docs).filter((f) => f.endsWith('.md'))

// where every source page ends up, and its URL
const pages = {}
for (const src of sources) {
  const changelog = src.match(/^change-log\/change-log-(.+)\.md$/)
  if (changelog) {
    pages[src] = { target: `content/changelog/${changelog[1]}.mdx`, url: `/changelog#v${changelog[1]}`, changelog: changelog[1] }
    continue
  }
  const target = src.replace(/(^|\/)README\.md$/, '$1index.md').replace(/\.md$/, '.mdx')
  const slug = target.replace(/\.mdx$/, '').replace(/(^|\/)index$/, '')
  pages[src] = { target: `content/docs/${target}`, url: `/docs${slug ? '/' + slug : ''}` }
}

function tagDate(version) {
  try {
    return execFileSync('git', ['log', '-1', '--format=%cs', `v${version}`], { cwd: repo }).toString().trim()
  } catch {
    return undefined
  }
}

function convert(source, from) {
  let text = source
  let frontmatter = {}
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/)
  if (fm) {
    frontmatter = parseYaml(fm[1]) ?? {}
    text = text.slice(fm[0].length)
  }
  const h1 = text.match(/^# (.+)\n/m)
  const title = h1 ? h1[1].trim() : posix.basename(from, '.md')
  if (h1) text = text.replace(h1[0], '')

  // {% code title="x" %} ```lang ... ``` {% endcode %}  ->  ```lang title="x"
  text = text.replace(
    /\{% code title="([^"]+)" %\}\s*\n```(\w*)[^\n]*\n([\s\S]*?)```\s*\n\{% endcode %\}/g,
    // a title without a language would be read as the language
    (_, file, lang, body) => '```' + (lang || 'txt') + ` title="${file}"\n` + body + '```'
  )
  // {% hint style="x" %} ... {% endhint %}  ->  <Callout>
  text = text.replace(
    /\{% hint style="(\w+)" %\}\n?([\s\S]*?)\{% endhint %\}/g,
    (_, style, body) => `<Callout type="${calloutTypes[style] ?? 'info'}">\n\n${body.trim()}\n\n</Callout>`
  )
  // {% tabs %}{% tab title="x" %}...{% endtab %}{% endtabs %}  ->  <Tabs>
  text = text.replace(/\{% tabs %\}([\s\S]*?)\{% endtabs %\}/g, (_, inner) => {
    const tabs = [...inner.matchAll(/\{% tab title="([^"]+)" %\}([\s\S]*?)\{% endtab %\}/g)]
    const items = tabs.map((t) => `'${t[1]}'`).join(', ')
    const body = tabs.map((t) => `<Tab value="${t[1]}">\n\n${t[2].trim()}\n\n</Tab>`).join('\n')
    return `<Tabs items={[${items}]}>\n${body}\n</Tabs>`
  })
  // {% content-ref url="x" %}[t](x){% endcontent-ref %}  ->  <Card>
  text = text.replace(
    /\{% content-ref url="([^"]+)" %\}\s*\[([^\]]+)\]\([^)]+\)\s*\{% endcontent-ref %\}/g,
    (_, url, label) => `<Cards>\n<Card title="${label}" href="${url}" />\n</Cards>`
  )

  text = rewriteImages(text, from)
  text = rewriteLinks(text, from)
  text = escapeProse(text)

  const head = ['---', `title: ${JSON.stringify(title)}`]
  const description = frontmatter.description && String(frontmatter.description).trim()
  if (description) head.push(`description: ${JSON.stringify(description)}`)
  const icon = icons[from] ?? (from.endsWith('README.md') ? icons[posix.dirname(from)] : undefined)
  if (icon) head.push(`icon: ${icon}`)
  const version = pages[from].changelog
  if (version) {
    head.push(`version: ${JSON.stringify(version)}`)
    const date = tagDate(version)
    if (date) head.push(`date: ${JSON.stringify(date)}`)
  }
  head.push('---', '')
  return head.join('\n') + text.trimStart()
}

// Links between pages become site URLs; anything else in the repo links to GitHub.
function rewriteLinks(text, from) {
  return text.replace(/\]\((?!https?:|#|mailto:|\/)([^)\s#]+)(#[^)\s]*)?\)/g, (match, target, anchor = '') => {
    const resolved = posix.normalize(posix.join(posix.dirname(from), target))
    if (pages[resolved]) return `](${pages[resolved].url}${anchor})`
    if (resolved.startsWith('../')) {
      return `](https://github.com/no0dles/hammerkit/blob/master/${resolved.slice(3)}${anchor})`
    }
    return `](https://github.com/no0dles/hammerkit/blob/master/docs/${resolved}${anchor})`
  })
}

// Images next to a page move to public/images/<folder>/.
function rewriteImages(text, from) {
  return text.replace(/!\[([^\]]*)\]\((?!https?:)([^)\s]+)\)/g, (_, alt, src) => {
    const resolved = posix.normalize(posix.join(posix.dirname(from), src))
    const destination = posix.join('images', resolved)
    mkdirSync(dirname(join(site, 'public', destination)), { recursive: true })
    copyFileSync(join(docs, resolved), join(site, 'public', destination))
    return `![${alt}](/${destination})`
  })
}

// MDX reads { } as expressions and < as JSX: escape them in prose, leaving
// fenced code, inline code and the JSX this script inserted untouched.
function escapeProse(text) {
  let fenced = false
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced
        return line
      }
      if (fenced || jsxLine.test(line)) return line
      return line
        .split(/(`[^`\n]*`)/)
        .map((part, i) => (i % 2 === 1 ? part : part.replace(/[{}]/g, (c) => '\\' + c).replace(/<(?!\/?[A-Z])/g, '&lt;')))
        .join('')
    })
    .join('\n')
}

// Sidebar order inside each folder follows SUMMARY.md.
function folderMetas() {
  const summary = readFileSync(join(repo, 'SUMMARY.md'), 'utf8')
  const order = [...new Set([...summary.matchAll(/\]\(docs\/([^)]+\.md)\)/g)].map((m) => m[1]))]
  for (const src of sources) if (!order.includes(src)) order.push(src) // e.g. the ADRs
  const titles = Object.fromEntries([...summary.matchAll(/\* \[([^\]]+)\]\(docs\/([^)]+)\)/g)].map((m) => [m[2], m[1]]))
  const folders = {}
  for (const src of order) {
    const page = pages[src]
    if (!page || page.changelog || !src.includes('/')) continue
    const folder = posix.dirname(src)
    folders[folder] ??= []
    folders[folder].push(posix.basename(page.target, '.mdx'))
  }
  const folderTitles = { guides: 'Guides', llm: 'AI agents', 'release-blog': 'Release notes', contribution: 'Contribution', adr: 'Architecture decisions' }
  for (const [folder, entries] of Object.entries(folders)) {
    const title = folderTitles[folder] ?? titles[`${folder}/README.md`] ?? folder
    const meta = { title, ...(icons[folder] ? { icon: icons[folder] } : {}), pages: entries }
    writeFileSync(join(site, 'content/docs', folder, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')
  }
}

for (const [from, page] of Object.entries(pages)) {
  if (handwritten.has(from)) continue
  const target = join(site, page.target)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, convert(readFileSync(join(docs, from), 'utf8'), from))
}
folderMetas()
console.log(`converted ${Object.keys(pages).length - handwritten.size} pages`)
