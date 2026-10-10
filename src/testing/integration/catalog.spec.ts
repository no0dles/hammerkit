import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { createCli } from '../../program'
import { summarizeRun } from '../../executer/run-summary'
import { expectSuccessfulResult } from '../expect'
import { createGitRepo, GitRepo, isolateHammerkitHome } from '../git-repo'
import { requiresLinuxContainers } from '../requires-linux-containers'
import { createTestCase } from '../test-case'

/*
 * Every catalog entry, consumed the way the docs show: included from a git
 * repository that holds the catalog, with its fixture project's inputs. The
 * fixture's `verify` task depends on the entry's tasks and checks their result,
 * so a passing run means the entry works; a second run must then come entirely
 * from the cache. Self-discovering over catalog/*.
 */

const catalogDir = join(__dirname, '..', '..', '..', 'catalog')

function readFiles(directory: string): { [fileName: string]: string } {
  const files: { [fileName: string]: string } = {}
  for (const fileName of readdirSync(directory, { recursive: true, encoding: 'utf8' })) {
    try {
      files[fileName.split('\\').join('/')] = readFileSync(join(directory, fileName), 'utf8')
    } catch {
      // a directory
    }
  }
  return files
}

const entries = readdirSync(catalogDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

describe.each(entries)('catalog %s', (entry) => {
  let repo: GitRepo
  let home: ReturnType<typeof isolateHammerkitHome>

  beforeEach(() => {
    home = isolateHammerkitHome()
    repo = createGitRepo()
    const files = readFiles(catalogDir)
    repo.commit(
      Object.fromEntries(Object.entries(files).map(([fileName, content]) => [`catalog/${fileName}`, content]))
    )
  })
  afterEach(() => {
    repo.remove()
    home.restore()
  })

  it(
    'runs verify, then again entirely from the cache',
    requiresLinuxContainers(async () => {
      const fixture = readFiles(join(catalogDir, entry, 'test'))
      fixture['.hammerkit.yaml'] = fixture['.hammerkit.yaml'].split('CATALOG_URL').join(repo.url)

      await createTestCase(`catalog-${entry}`, fixture).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {
          taskName: 'verify',
          environmentName: null,
        })
        await cli.clean({ cache: true })

        const first = await cli.runExec()
        await expectSuccessfulResult(first, environment)
        expect(summarizeRun(first.state, 0).cached).toBe(0)

        const second = await cli.runExec()
        await expectSuccessfulResult(second, environment)
        expect(summarizeRun(second.state, 0)).toMatchObject({ executed: 0, failed: 0, cancelled: 0 })
      })
    })
  )
})
