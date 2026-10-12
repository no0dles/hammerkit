import { HOST_RUNS_YAML } from '../testing/host-env'
import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createTestKey, signToken, startTestIssuer } from '../testing/test-issuer'
import { hashBundle } from './bundle'
import { collectBundle } from './collect-bundle'
import { readServerConfig } from '../server/server-config'
import { startServer } from '../server/server'
import { writeFileSync } from 'fs'

const entry = `tasks:
  build:
    cmds: [echo build]
includes:
  more: ./tasks/more.yaml
`

describe('collectBundle', () => {
  it('takes the build file and the local files it includes, below its own directory', async () => {
    await createTestCase('collect-bundle-includes', {
      '.hammerkit.yaml': entry,
      'tasks/more.yaml': 'includes:\n  deep: ./deep/deep.yaml\ntasks:\n  lint:\n    cmds: [echo lint]\n',
      'tasks/deep/deep.yaml': 'tasks:\n  scan:\n    cmds: [echo scan]\n',
      'unrelated.yaml': 'tasks: {}\n',
    }).setup(async (cwd, environment) => {
      const bundle = await collectBundle(join(cwd, '.hammerkit.yaml'), environment)
      expect(bundle.entry).toBe('.hammerkit.yaml')
      expect(Object.keys(bundle.files).sort()).toEqual(['.hammerkit.yaml', 'tasks/deep/deep.yaml', 'tasks/more.yaml'])
      expect(bundle.files['.hammerkit.yaml']).toBe(entry)
    })
  })

  it('names the build file relative to its directory, whatever it is called', async () => {
    await createTestCase('collect-bundle-named', { 'ci/build.yaml': 'tasks:\n  a:\n    cmds: [echo]\n' }).setup(
      async (cwd, environment) => {
        const bundle = await collectBundle(join(cwd, 'ci', 'build.yaml'), environment)
        expect(bundle.entry).toBe('build.yaml')
        expect(Object.keys(bundle.files)).toEqual(['build.yaml'])
      }
    )
  })

  it('is the same bundle, with the same version, for the same files', async () => {
    await createTestCase('collect-bundle-hash', {
      '.hammerkit.yaml': entry,
      'tasks/more.yaml': 'tasks:\n  lint:\n    cmds: [echo lint]\n',
    }).setup(async (cwd, environment) => {
      const first = await collectBundle(join(cwd, '.hammerkit.yaml'), environment)
      const second = await collectBundle(join(cwd, '.hammerkit.yaml'), environment)
      expect(hashBundle(first)).toBe(hashBundle(second))
      writeFileSync(join(cwd, 'tasks/more.yaml'), 'tasks:\n  lint:\n    cmds: [echo changed]\n')
      expect(hashBundle(await collectBundle(join(cwd, '.hammerkit.yaml'), environment))).not.toBe(hashBundle(first))
    })
  })

  it('refuses what a server could not reproduce', async () => {
    await createTestCase('collect-bundle-outside', {
      'project/.hammerkit.yaml': 'includes:\n  shared: ../shared/shared.yaml\n',
      'shared/shared.yaml': 'tasks:\n  a:\n    cmds: [echo]\n',
    }).setup(async (cwd, environment) => {
      await expect(collectBundle(join(cwd, 'project', '.hammerkit.yaml'), environment)).rejects.toThrow(
        'can only include files below its own directory'
      )
    })
    await createTestCase('collect-bundle-missing', {}).setup(async (cwd, environment) => {
      await expect(collectBundle(join(cwd, '.hammerkit.yaml'), environment)).rejects.toThrow('there is no build file')
    })
  })

  it('refuses a bundle the server would not take', async () => {
    const includes = Array.from({ length: 200 }, (_, i) => `  x${i}: ./f${i}.yaml`).join('\n')
    const files: Record<string, string> = { '.hammerkit.yaml': `includes:\n${includes}\n` }
    for (let i = 0; i < 200; i++) {
      files[`f${i}.yaml`] = 'tasks: {}\n'
    }
    await createTestCase('collect-bundle-big', files).setup(async (cwd, environment) => {
      await expect(collectBundle(join(cwd, '.hammerkit.yaml'), environment)).rejects.toThrow('more than 200 files')
    })
  })

  it('computes the version the server computes', async () => {
    const key = createTestKey('ES256', 'k1')
    const idp = await startTestIssuer([key])
    try {
      await createTestCase('collect-bundle-server', {
        '.hammerkit.yaml': entry,
        'tasks/more.yaml': 'tasks:\n  lint:\n    cmds: [echo lint]\n',
      }).setup(async (cwd, environment) => {
        const file = join(cwd, 'server.yaml')
        writeFileSync(
          file,
          [
            HOST_RUNS_YAML,
            'listen: { port: 0 }',
            `storage: { directory: ${JSON.stringify(join(cwd, 'data'))} }`,
            'issuers:',
            `  - { issuer: "${idp.url}", audience: hammerkit }`,
            'entitlements:',
            `  - subject: { iss: "${idp.url}", sub: alice }`,
            '    builds: publish',
            '',
          ].join('\n')
        )
        const server = await startServer(await readServerConfig(environment, file), environment)
        try {
          const bundle = await collectBundle(join(cwd, '.hammerkit.yaml'), environment)
          const token = signToken(key, {
            iss: idp.url,
            sub: 'alice',
            aud: 'hammerkit',
            exp: Math.floor(Date.now() / 1000) + 300,
          })
          const response = await fetch(`${server.url}/v1/definitions`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(bundle),
          })
          expect(response.status).toBe(201)
          expect(((await response.json()) as { hash: string }).hash).toBe(hashBundle(bundle))
        } finally {
          await server.close()
        }
      })
    } finally {
      await idp.close()
    }
  })
})
