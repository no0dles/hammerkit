import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { parse as yamlParse } from 'yaml'
import { buildFileSchema } from '../schema/build-file-schema'
import { isGitSource } from '../schema/build-file-include-schema'

/*
 * Structure of the catalog (catalog/<entry>/): every entry is a valid build file,
 * has a fixture project that consumes it, and a docs page that lists its tasks and
 * inputs. Self-discovering, so a new entry is checked the moment it is added. The
 * behavior (the entry really runs, then comes from the cache) is checked by
 * src/testing/integration/catalog.spec.ts.
 */

const repoRoot = join(__dirname, '..', '..')
const catalogDir = join(repoRoot, 'catalog')
const docsDir = join(repoRoot, 'website', 'content', 'docs', 'catalog')

const entries = readdirSync(catalogDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

const readYaml = (file: string) => yamlParse(readFileSync(file, 'utf8'))

describe('catalog', () => {
  it('has entries', () => {
    expect(entries.length).toBeGreaterThan(0)
  })

  it('has an overview page', () => {
    expect(existsSync(join(docsDir, 'index.mdx'))).toBe(true)
  })

  describe.each(entries)('%s', (entry) => {
    const buildFile = join(catalogDir, entry, 'build.yaml')
    const fixture = join(catalogDir, entry, 'test', '.hammerkit.yaml')
    const page = join(docsDir, `${entry}.mdx`)

    it('is a valid build file', () => {
      const result = buildFileSchema.safeParse(readYaml(buildFile))
      expect(result.success).toBe(true)
    })

    it('pins the image of every task', () => {
      const tasks = Object.entries(buildFileSchema.parse(readYaml(buildFile)).tasks ?? {})
      expect(tasks.length).toBeGreaterThan(0)
      for (const [name, task] of tasks) {
        const image = 'image' in task ? task.image : null
        expect({ name, image }).toEqual({ name, image: expect.stringMatching(/:[^:]+$/) })
        expect(image).not.toMatch(/:latest$/)
      }
    })

    it('has a fixture that includes the entry from git and runs verify', () => {
      const consumer = buildFileSchema.parse(readYaml(fixture))
      const include = consumer.includes?.[entry]
      expect(include && isGitSource(include) ? { git: include.git, path: include.path } : include).toEqual({
        git: 'CATALOG_URL',
        path: `catalog/${entry}`,
      })
      expect(consumer.tasks?.verify).toBeDefined()
    })

    it('passes only inputs the entry declares', () => {
      const declared = Object.keys(buildFileSchema.parse(readYaml(buildFile)).envs ?? {})
      const include = buildFileSchema.parse(readYaml(fixture)).includes?.[entry]
      const given = include && isGitSource(include) ? Object.keys(include.with ?? {}) : []
      for (const name of given) {
        expect(declared).toContain(name)
      }
    })

    it('is documented: every task and input is on its page', () => {
      expect(existsSync(page)).toBe(true)
      const text = readFileSync(page, 'utf8')
      const parsed = buildFileSchema.parse(readYaml(buildFile))
      for (const name of [...Object.keys(parsed.tasks ?? {}), ...Object.keys(parsed.envs ?? {})]) {
        expect(text).toContain(`\`${name}\``)
      }
    })
  })
})
