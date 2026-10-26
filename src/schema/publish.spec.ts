import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'

describe('publish: false', () => {
  it('changes nothing locally, and an include can be an object with a path', async () => {
    await createTestCase('publish-false-local', {
      '.hammerkit.yaml': {
        includes: { infra: { path: './infra.yaml', publish: false }, lib: { path: './lib.yaml' } },
        services: { db: { image: 'postgres:16', publish: false } },
        tasks: { watch: { cmds: ['echo watch'], needs: ['db'], deps: ['infra:up', 'lib:build'], publish: false } },
      },
      'infra.yaml': { tasks: { up: { cmds: ['echo up'] } } },
      'lib.yaml': { tasks: { build: { cmds: ['echo build'] } } },
    }).setup(async (cwd, environment) => {
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {})
      expect(
        cli
          .task('watch')
          .deps.map((dep) => dep.name)
          .sort()
      ).toEqual(['infra:up', 'lib:build'])
      expect(cli.task('watch').needs.map((need) => need.service.name)).toEqual(['db'])
    })
  })
})
