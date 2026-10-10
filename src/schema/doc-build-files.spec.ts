import { existsSync, readFileSync, readdirSync } from 'fs'
import { basename, join, relative } from 'path'
import { parse as yamlParse } from 'yaml'
import { buildFileSchema } from './build-file-schema'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'

/*
 * Documentation coverage: every hammerkit build-file example that ships in the
 * docs must stay valid against the real schema, so the docs cannot silently
 * drift to config the tool would reject.
 *
 * The harness is self-discovering: it walks website/content/docs at collection time and turns
 * every fenced ```yaml block into its own assertion. A block is treated as a
 * hammerkit build file when it parses to an object whose top-level keys are all
 * part of the schema (envs/tasks/services/...). Anything else (a GitLab/GitHub
 * CI snippet, a design-doc proposal) is "foreign" and must be listed in
 * FOREIGN_BLOCKS with a reason — a foreign block that is NOT listed fails the
 * audit, so a new build-file example is validated rather than quietly ignored,
 * and a typo'd example (unknown key) is surfaced instead of skipped.
 */

const repoRoot = join(__dirname, '..', '..')
// the pages of hammerkit.dev
const docsDir = join(repoRoot, 'website', 'content', 'docs')
const bestPracticesDir = join(repoRoot, 'best-practices')

// Top-level keys the build-file schema understands. Mirrors buildFileSchema's
// shape; kept here only to classify "is this block a hammerkit build file at all".
const KNOWN_TOP_KEYS = new Set([
  'envs',
  'tasks',
  'services',
  'references',
  'includes',
  'environments',
  'caches',
  'labels',
  'runner',
])

// A doc block can declare itself intentionally invalid by putting this comment
// on its first line; the harness then asserts the schema REJECTS it.
const EXPECT_INVALID = '# hammerkit:expect-invalid'

// Directories that document a specific past version, not the current build-file
// reference. Their snippets are expected to use the syntax of their release and
// must not be validated against today's schema.
const HISTORICAL_DIRS = ['release-blog']

// yaml blocks in docs/ that are deliberately NOT hammerkit build files. Each is
// matched by a unique snippet of its body. Keep the reason — these are the only
// blocks allowed to be unrecognized.
const FOREIGN_BLOCKS: { file: string; snippet: string; reason: string }[] = [
  {
    file: join('cli', 'server.mdx'),
    snippet: 'audience: hammerkit',
    reason: 'server config (hammerkit server --config), not a build file',
  },
  {
    file: join('cli', 'remote.mdx'),
    snippet: 'issuer: https://login.example.com',
    reason: 'host config (~/.hammerkit/config.yaml), not a build file',
  },
  {
    file: join('installation.mdx'),
    snippet: 'DOCKER_TLS_CERTDIR',
    reason: 'GitLab CI (.gitlab-ci.yml) example, not a hammerkit build file',
  },
  {
    file: join('installation.mdx'),
    snippet: 'no0dles/hammerkit-github-action',
    reason: 'GitHub Actions workflow example, not a hammerkit build file',
  },
  {
    file: join('cli', 'store-restore.mdx'),
    snippet: 'before_script',
    reason: 'GitLab CI (gitlab-ci.yml) caching example, not a hammerkit build file',
  },
  {
    file: join('guides', 'ci-caching.mdx'),
    snippet: 'actions/cache@v4',
    reason: 'GitHub Actions workflow example, not a hammerkit build file',
  },
  {
    file: join('guides', 'migrate-ci', 'agent-guide.mdx'),
    snippet: 'docker/login-action@v3',
    reason: 'GitHub Actions workflow template for the CI migration guide, not a hammerkit build file',
  },
  {
    file: join('contribution', 'secret-managers.mdx'),
    snippet: 'secret://vault',
    reason: 'design-doc proposal for an unimplemented secrets: provider; not valid against the current schema',
  },
]

interface YamlBlock {
  body: string
  startLine: number
}

interface DocBlock extends YamlBlock {
  /** path relative to website/content/docs, using the host separator */
  relFile: string
  index: number
}

function walkMarkdown(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkMarkdown(full))
    } else if (entry.name.endsWith('.mdx')) {
      out.push(full)
    }
  }
  return out
}

// Extract the body of every fenced ```yaml / ```yml block. GitBook's
// `{% code %}` wrappers and `{% hint %}`/`{% tabs %}` around a block are
// irrelevant — only the fence matters.
function extractYamlBlocks(content: string): YamlBlock[] {
  const lines = content.split(/\r?\n/)
  const blocks: YamlBlock[] = []
  for (let i = 0; i < lines.length; i++) {
    // site pages carry a title on the fence (```yaml title=".hammerkit.yaml")
    if (!/^\s*```ya?ml(\s.*)?$/.test(lines[i])) {
      continue
    }
    const start = i + 1
    const body: string[] = []
    let j = start
    while (j < lines.length && !/^\s*```\s*$/.test(lines[j])) {
      body.push(lines[j])
      j++
    }
    blocks.push({ body: body.join('\n'), startLine: start + 1 })
    i = j
  }
  return blocks
}

function firstNonEmptyLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    if (line.trim() !== '') {
      return line.trim()
    }
  }
  return ''
}

// A block is a hammerkit build file when it parses to a non-empty object whose
// top-level keys are all part of the schema.
function isBuildFileShaped(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false
  }
  const keys = Object.keys(parsed as Record<string, unknown>)
  return keys.length > 0 && keys.every((k) => KNOWN_TOP_KEYS.has(k))
}

const allBlocks: DocBlock[] = []
for (const file of walkMarkdown(docsDir).sort()) {
  const relFile = relative(docsDir, file)
  const topDir = relFile.split(/[\\/]/)[0]
  if (HISTORICAL_DIRS.includes(topDir)) {
    continue
  }
  extractYamlBlocks(readFileSync(file, 'utf8')).forEach((block, index) => {
    allBlocks.push({ ...block, relFile, index })
  })
}

const foreignMatches = new Set<number>()
let buildFileBlockCount = 0

describe('docs build-file examples', () => {
  // Group assertions per doc file for readable failures.
  const byFile = new Map<string, DocBlock[]>()
  for (const block of allBlocks) {
    const list = byFile.get(block.relFile) ?? []
    list.push(block)
    byFile.set(block.relFile, list)
  }

  for (const [relFile, blocks] of byFile) {
    describe(relFile, () => {
      blocks.forEach((block) => {
        const label = `yaml block at line ${block.startLine}`

        const foreignIndex = FOREIGN_BLOCKS.findIndex((f) => f.file === relFile && block.body.includes(f.snippet))

        if (foreignIndex >= 0) {
          foreignMatches.add(foreignIndex)
          it(`${label} is a documented non-hammerkit block`, () => {
            // Listed in FOREIGN_BLOCKS with a reason — nothing to validate.
            expect(FOREIGN_BLOCKS[foreignIndex].reason).toBeTruthy()
          })
          return
        }

        if (firstNonEmptyLine(block.body) === EXPECT_INVALID) {
          it(`${label} is rejected by the schema (marked expect-invalid)`, async () => {
            const parsed = yamlParse(block.body)
            const result = await buildFileSchema.safeParseAsync(parsed)
            expect(result.success).toBe(false)
          })
          buildFileBlockCount++
          return
        }

        it(`${label} is a valid build file`, async () => {
          let parsed: unknown
          try {
            parsed = yamlParse(block.body)
          } catch (e) {
            throw new Error(`${relFile}:${block.startLine} is not valid YAML: ${(e as Error).message}`)
          }

          if (!isBuildFileShaped(parsed)) {
            const keys =
              parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? Object.keys(parsed as Record<string, unknown>).join(', ')
                : typeof parsed
            throw new Error(
              `${relFile}:${block.startLine} is not a recognized hammerkit build file (top-level: ${keys}).\n` +
                `If this is intentionally foreign yaml (a CI config, a proposal), add it to FOREIGN_BLOCKS with a reason.\n` +
                `Otherwise fix the example so its top-level keys are one of: ${[...KNOWN_TOP_KEYS].join(', ')}.`
            )
          }

          const result = await buildFileSchema.safeParseAsync(parsed)
          if (!result.success) {
            throw new Error(
              `${relFile}:${block.startLine} fails the build-file schema:\n` +
                result.error.issues.map((iss) => `  - ${iss.path.join('.')}: ${iss.message}`).join('\n')
            )
          }
        })
        buildFileBlockCount++
      })
    })
  }

  // Guard against a regex/discovery regression silently matching nothing, and
  // against a build-file example dropping out of validation unnoticed.
  it('discovers the documented build-file examples', () => {
    expect(buildFileBlockCount).toBeGreaterThanOrEqual(60)
  })

  // Every documented exclusion must still match a real block, so stale entries
  // are removed when the doc changes.
  it('has no stale FOREIGN_BLOCKS entries', () => {
    const unmatched = FOREIGN_BLOCKS.filter((_, i) => !foreignMatches.has(i)).map((f) => `${f.file} (${f.snippet})`)
    expect(unmatched).toEqual([])
  })
})

// `<include cwd ...>path</include>` embeds a repository file into a page at build
// time, resolved from website/. The tutorials embed their tested examples this way.
const websiteDir = join(repoRoot, 'website')
const includes = walkMarkdown(docsDir)
  .sort()
  .flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(/<include cwd[^>]*>([^<]+)<\/include>/g)].map((match) => ({
      relFile: relative(docsDir, file),
      // MDX reads `\_` as a literal `_` (an `__init__.py` path needs the escapes)
      path: join(websiteDir, match[1].trim().replace(/\\(.)/g, '$1')),
    }))
  )

describe('docs includes', () => {
  it('finds the included files', () => {
    expect(includes.length).toBeGreaterThanOrEqual(20)
  })

  it.each(includes.map((include) => [include.relFile, relative(repoRoot, include.path)]))(
    '%s includes %s, which exists',
    (_, path) => {
      expect(existsSync(join(repoRoot, path))).toBe(true)
    }
  )
})

// Each tutorial shows its build file step by step and then includes the complete
// file from its example, which the integration tests run (tutorial-*.spec.ts).
// Every task and env a step shows must be exactly the example's, so the steps
// cannot drift from what is tested.
describe('tutorial snippets match their tested example', () => {
  const tutorialsDir = join(docsDir, 'tutorials')
  const tutorials = readdirSync(tutorialsDir)
    .filter((name) => name.endsWith('.mdx') && name !== 'index.mdx')
    .sort()

  it('finds the tutorials', () => {
    expect(tutorials).toEqual(['dotnet.mdx', 'go.mdx', 'java.mdx', 'node.mdx', 'python.mdx', 'rust.mdx'])
  })

  describe.each(tutorials)('%s', (name) => {
    const example = `tutorial-${basename(name, '.mdx')}`
    const exampleFile = join(repoRoot, 'examples', example, '.hammerkit.yaml')
    const content = readFileSync(join(tutorialsDir, name), 'utf8')

    it(`includes examples/${example}/.hammerkit.yaml`, () => {
      expect(content).toContain(`>../examples/${example}/.hammerkit.yaml</include>`)
    })

    it(`shows only tasks and envs exactly as examples/${example} defines them`, () => {
      const expected = yamlParse(readFileSync(exampleFile, 'utf8'))
      const blocks = extractYamlBlocks(content).map((block) => yamlParse(block.body))
      expect(blocks.length).toBeGreaterThan(0)
      for (const block of blocks) {
        expect(Object.keys(block).every((key) => key === 'tasks' || key === 'envs')).toBe(true)
        for (const [task, definition] of Object.entries(block.tasks ?? {})) {
          expect({ task, definition }).toEqual({ task, definition: expected.tasks[task] })
        }
        for (const [env, value] of Object.entries(block.envs ?? {})) {
          expect({ env, value }).toEqual({ env, value: expected.envs[env] })
        }
      }
    })
  })
})

// The landing page (website/components/home) shows a build file and the commands
// run against it. The snippets are plain template literals, read as text here
// because website/ is outside this package.
describe('landing page snippets', () => {
  const homeDir = join(websiteDir, 'components', 'home')
  const snippets = readFileSync(join(homeDir, 'snippets.ts'), 'utf8')
  const snippet = (name: string): string => {
    const match = new RegExp(`export const ${name} = \`([^\`]*)\``).exec(snippets)
    if (!match) {
      throw new Error(`snippet ${name} not found in snippets.ts`)
    }
    return match[1]
  }
  const commands = [snippet('githubCi'), snippet('gitlabCi'), readFileSync(join(homeDir, 'terminal.tsx'), 'utf8')]
  const ranTasks = commands.flatMap((code) => [...code.matchAll(/hammerkit run ([\w:-]+)/g)].map((match) => match[1]))
  const remotes = commands.flatMap((code) => [...code.matchAll(/--remote ([\w-]+)/g)].map((match) => match[1]))

  it('the CI files are valid YAML', () => {
    for (const name of ['githubCi', 'gitlabCi']) {
      expect(() => yamlParse(snippet(name).replace(/\\\$/g, '$'))).not.toThrow()
    }
  })

  it('the build file is valid', async () => {
    const result = await buildFileSchema.safeParseAsync(yamlParse(snippet('buildFile')))
    expect(result.success).toBe(true)
  })

  it('the build file declares every cache the page pulls from or pushes to', () => {
    expect(remotes).toContain('shared')
    const caches = Object.keys(yamlParse(snippet('buildFile')).caches ?? {})
    expect(caches).toEqual(expect.arrayContaining([...new Set(remotes)]))
  })

  it('the build file defines every task the page runs', async () => {
    expect(ranTasks).toContain('ci')
    await createTestCase('landing-page-snippets', { '.hammerkit.yaml': snippet('buildFile') }).setup(
      async (cwd, environment) => {
        for (const taskName of new Set(ranTasks)) {
          const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName })
          expect(cli.task(taskName).name).toBe(taskName)
        }
      }
    )
  })
})

describe('best-practices build configs', () => {
  const files = readdirSync(bestPracticesDir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort()

  it('finds the best-practices templates', () => {
    expect(files.length).toBeGreaterThanOrEqual(10)
  })

  it.each(files)('%s is a valid build file', async (name) => {
    const parsed = yamlParse(readFileSync(join(bestPracticesDir, name), 'utf8'))
    const result = await buildFileSchema.safeParseAsync(parsed)
    if (!result.success) {
      throw new Error(
        `best-practices/${name} fails the build-file schema:\n` +
          result.error.issues.map((iss) => `  - ${iss.path.join('.')}: ${iss.message}`).join('\n')
      )
    }
  })
})
