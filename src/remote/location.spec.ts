import { join } from 'path'
import { writeFileSync } from 'fs'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { Environment } from '../executer/environment'
import { WorkTree } from '../planner/work-tree'
import { ParseError } from '../schema/parse-error'
import { resolveRunLocation } from './location'

const config = `
servers:
  mac-mini: { url: https://mac-mini.corp, issuer: https://idp.corp }
  corp-k8s: { url: https://hammerkit.corp, issuer: https://idp.corp }
`

function treeWith(...runners: (string | null)[]): WorkTree {
  const tasks: Record<string, unknown> = {}
  runners.forEach((runner, i) => (tasks[`t${i}`] = { data: { runner } }))
  return { tasks, services: {} } as unknown as WorkTree
}

async function withConfig(
  name: string,
  yaml: string,
  fn: (environment: Environment, cwd: string) => Promise<void>
): Promise<void> {
  await createTestCase(name, {}).setup(async (cwd, environment) => {
    const file = join(cwd, 'config.yaml')
    writeFileSync(file, yaml)
    environment.processEnvs = { ...environment.processEnvs, HAMMERKIT_CONFIG: file, HAMMERKIT_ON: '' }
    await fn(environment, cwd)
  })
}

describe('resolveRunLocation', () => {
  it('runs locally when nothing says otherwise', async () => {
    await withConfig('location-default', config, async (env) => {
      expect(await resolveRunLocation(treeWith(null), env)).toEqual({ type: 'local' })
    })
  })

  it('runs locally without a config file', async () => {
    await createTestCase('location-no-config', {}).setup(async (cwd, env) => {
      env.processEnvs = { ...env.processEnvs, HAMMERKIT_CONFIG: join(cwd, 'missing.yaml'), HAMMERKIT_ON: '' }
      expect(await resolveRunLocation(treeWith(null), env)).toEqual({ type: 'local' })
    })
  })

  it('uses the runner of the tasks', async () => {
    await withConfig('location-runner', config, async (env) => {
      const location = await resolveRunLocation(treeWith('mac-mini', null, 'mac-mini'), env)
      expect(location).toMatchObject({ type: 'server', name: 'mac-mini' })
    })
  })

  it('uses run.on of the host config below the runner of the tasks', async () => {
    await withConfig('location-host-default', `${config}run: { on: corp-k8s }\n`, async (env) => {
      expect(await resolveRunLocation(treeWith(null), env)).toMatchObject({ name: 'corp-k8s' })
      expect(await resolveRunLocation(treeWith('mac-mini'), env)).toMatchObject({ name: 'mac-mini' })
    })
  })

  it('treats auto as the runner of the tasks, else local', async () => {
    await withConfig('location-auto', `${config}run: { on: auto }\n`, async (env) => {
      expect(await resolveRunLocation(treeWith(null), env)).toEqual({ type: 'local' })
      expect(await resolveRunLocation(treeWith('mac-mini'), env)).toMatchObject({ name: 'mac-mini' })
      expect(await resolveRunLocation(treeWith('mac-mini'), env, { on: 'auto' })).toMatchObject({ name: 'mac-mini' })
    })
  })

  it('lets HAMMERKIT_ON override the tasks and the host config', async () => {
    await withConfig('location-env', `${config}run: { on: corp-k8s }\n`, async (env) => {
      env.processEnvs = { ...env.processEnvs, HAMMERKIT_ON: 'mac-mini' }
      expect(await resolveRunLocation(treeWith('corp-k8s'), env)).toMatchObject({ name: 'mac-mini' })
      env.processEnvs = { ...env.processEnvs, HAMMERKIT_ON: 'local' }
      expect(await resolveRunLocation(treeWith('corp-k8s'), env)).toEqual({ type: 'local' })
    })
  })

  it('lets --on and --local override everything', async () => {
    await withConfig('location-flags', `${config}run: { on: corp-k8s }\n`, async (env) => {
      env.processEnvs = { ...env.processEnvs, HAMMERKIT_ON: 'corp-k8s' }
      expect(await resolveRunLocation(treeWith('corp-k8s'), env, { on: 'mac-mini' })).toMatchObject({
        name: 'mac-mini',
      })
      expect(await resolveRunLocation(treeWith('corp-k8s'), env, { local: true })).toEqual({ type: 'local' })
      await expect(resolveRunLocation(treeWith(null), env, { on: 'mac-mini', local: true })).rejects.toThrow(
        'contradict'
      )
    })
  })

  it('sends tasks naming different servers to --on, but rejects them otherwise', async () => {
    await withConfig('location-two-runners', config, async (env) => {
      await expect(resolveRunLocation(treeWith('mac-mini', 'corp-k8s'), env)).rejects.toThrow(
        'a run goes to one server, but its tasks name corp-k8s, mac-mini'
      )
      expect(await resolveRunLocation(treeWith('mac-mini', 'corp-k8s'), env, { on: 'corp-k8s' })).toMatchObject({
        name: 'corp-k8s',
      })
    })
  })

  it('never falls back to local for an unregistered server', async () => {
    await withConfig('location-unknown', config, async (env) => {
      await expect(resolveRunLocation(treeWith('nope'), env)).rejects.toThrow(
        'server nope is not registered, add it with: hammerkit remote add nope <url> --issuer <url>'
      )
      await expect(resolveRunLocation(treeWith(null), env, { on: 'nope' })).rejects.toThrow('not registered')
    })
  })
})

describe('task runner', () => {
  it('comes from the task, the extended task or the build file default', async () => {
    const buildFile = {
      runner: 'mac-mini',
      tasks: {
        plain: { cmds: ['echo plain'] },
        own: { cmds: ['echo own'], runner: 'corp-k8s' },
        base: { cmds: ['echo base'], runner: 'corp-k8s' },
        child: { extend: 'base', cmds: ['echo child'] },
        override: { extend: 'base', cmds: ['echo override'], runner: 'mac-mini' },
      },
    }
    await createTestCase('task-runner', { '.hammerkit.yaml': buildFile }).setup(async (cwd, environment) => {
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {})
      const runner = (name: string) => cli.task(name).data.runner
      expect(runner('plain')).toBe('mac-mini')
      expect(runner('own')).toBe('corp-k8s')
      expect(runner('child')).toBe('corp-k8s')
      expect(runner('override')).toBe('mac-mini')
    })
  })

  it('refuses to run locally when the server is not registered', async () => {
    const buildFile = { tasks: { build: { cmds: ['echo build'], runner: 'nope' } } }
    await createTestCase('task-runner-unknown', { '.hammerkit.yaml': buildFile }).setup(async (cwd, environment) => {
      environment.processEnvs = { ...environment.processEnvs, HAMMERKIT_CONFIG: join(cwd, 'c.yaml'), HAMMERKIT_ON: '' }
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'build' })
      await expect(cli.runExec()).rejects.toThrow('server nope is not registered')
    })
  })

  it('says that running on a server is not available yet', async () => {
    const buildFile = { tasks: { build: { cmds: ['echo build'], runner: 'mac-mini' } } }
    await createTestCase('task-runner-registered', { '.hammerkit.yaml': buildFile }).setup(async (cwd, environment) => {
      const file = join(cwd, 'config.yaml')
      writeFileSync(file, config)
      environment.processEnvs = { ...environment.processEnvs, HAMMERKIT_CONFIG: file, HAMMERKIT_ON: '' }
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'build' })
      await expect(cli.runExec()).rejects.toThrow('running on a server is not available yet')
    })
  })

  it('rejects local and auto as a runner', async () => {
    const buildFile = { tasks: { build: { cmds: ['echo build'], runner: 'local' } } }
    await createTestCase('task-runner-reserved', { '.hammerkit.yaml': buildFile }).setup(async (cwd, environment) => {
      const error = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'build' }).catch((e) => e)
      expect(error).toBeInstanceOf(ParseError)
      expect(error.zod.issues[0].message).toContain('local and auto are no servers')
    })
  })
})
