import { tmpdir } from 'os'
import { environmentMock } from '../executer/environment-mock'
import { Environment } from '../executer/environment'
import { Bundle } from '../remote/bundle'
import { DefinitionError, planBundle } from './plan'
import { getSecretCatalog, serverConfigSchema } from './server-config'
import { planRun, refuseArguments } from './run-plan'

const config = serverConfigSchema.parse({
  issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit' }],
  secretProviders: { gsm: { command: ['gcloud', 'secrets', '{{ref}}'] } },
  accounts: {
    ci: { providers: { gsm: { env: {} } } },
    prod: { description: 'Production', providers: { gsm: { env: {} } } },
  },
})

const hosted: Environment = {
  ...environmentMock(tmpdir()),
  processEnvs: { PATH: '/bin', SERVER_ONLY: 'x' },
  hosted: { catalog: getSecretCatalog(config) },
}
const policy = { envs: ['PATH'] }

const bundle = (yaml: string, files: { [path: string]: string } = {}): Bundle => ({
  entry: '.hammerkit.yaml',
  files: { '.hammerkit.yaml': yaml, ...files },
})

const build = `
tasks:
  build:
    cmds: [echo build]
  deploy:
    deps: [build]
    secrets:
      - { from: "gsm:kube-token", account: prod, env: KUBE_TOKEN }
    cmds: [./deploy.sh]
  test:
    image: node:22
    secrets:
      - { from: "gsm:test-db", account: ci, env: DB }
    cmds: [npm test]
`

describe('planBundle on a server', () => {
  it('says what each task does, which accounts it uses and where its secrets come from', async () => {
    const planned = await planBundle(bundle(build), hosted, { policy })
    expect(planned.accounts).toEqual(['ci', 'prod'])
    expect(planned.plan.deploy).toEqual({
      kind: 'task',
      runtime: 'local',
      cmds: ['./deploy.sh'],
      command: './deploy.sh',
      network: 'open',
      deps: ['build'],
      needs: [],
      accounts: ['prod'],
      secrets: [{ from: 'gsm:kube-token', account: 'prod', target: 'KUBE_TOKEN' }],
      mounts: [],
      ports: [],
      generates: [],
      flags: ['local-task'],
    })
    expect(planned.plan.test).toMatchObject({ runtime: 'docker', image: 'node:22', accounts: ['ci'], flags: [] })
    expect(planned.plan.build.accounts).toEqual([])
    // never a value
    expect(JSON.stringify(planned)).not.toMatch(/token-value/)
  })

  it('plans only what a run executes, with its dependencies', async () => {
    const files = bundle(build)
    expect((await planRun(files, { tasks: ['build'], options: {} }, hosted, policy)).accounts).toEqual([])
    const deploy = await planRun(files, { tasks: ['deploy'], options: {} }, hosted, policy)
    expect(Object.keys(deploy.plan)).toEqual(['build', 'deploy'])
    expect(deploy.accounts).toEqual(['prod'])
    // several tasks add up
    expect((await planRun(files, { tasks: ['test', 'deploy'], options: {} }, hosted, policy)).accounts).toEqual([
      'ci',
      'prod',
    ])
  })

  it('includes the services a task needs and the init task of a service', async () => {
    const yaml = `
services:
  db:
    image: postgres:16
    ports: ['5432:5432']
    secrets:
      - { from: "gsm:db-password", account: prod, env: POSTGRES_PASSWORD }
tasks:
  test:
    image: node:22
    needs: [db]
    cmds: [npm test]
`
    const planned = await planRun(bundle(yaml), { tasks: ['test'], options: {} }, hosted, policy)
    expect(planned.accounts).toEqual(['prod'])
    expect(planned.plan.db).toMatchObject({
      kind: 'service',
      image: 'postgres:16',
      ports: ['5432:5432'],
      flags: ['host-port'],
    })
    expect(planned.plan.test.needs).toEqual(['db'])
  })

  it('shows the last command of each task and the cmd of each service, where arguments land', async () => {
    const yaml = `
services:
  api:
    image: node:22
    cmd: node server.js
    network: { allow: [registry.npmjs.org] }
tasks:
  setup:
    image: node:22
    cmds: [npm ci, npx vitest run]
    network: none
  empty:
    image: node:22
`
    const planned = await planBundle(bundle(yaml), hosted, { policy })
    expect(planned.plan.setup).toMatchObject({ command: 'npx vitest run', network: 'none' })
    expect(planned.plan.empty.command).toBeNull()
    expect(planned.plan.api).toMatchObject({
      command: 'node server.js',
      network: { allow: ['registry.npmjs.org'] },
    })
  })

  it('appends the arguments of a run to the last command of its task, never to a dependency', async () => {
    const yaml = `
tasks:
  build:
    image: node:22
    cmds: [npm run build]
  test:
    image: node:22
    deps: [build]
    cmds: [npm ci, npx vitest run]
`
    const run = { tasks: ['test'], options: { args: ['src/login.spec.ts', '-t', "it's a; rm -rf /"] } }
    const planned = await planRun(bundle(yaml), run, hosted, policy)
    expect(planned.plan.test.cmds).toEqual(['npm ci', `npx vitest run 'src/login.spec.ts' '-t' 'it'\\''s a; rm -rf /'`])
    expect(planned.plan.test.command).toEqual(planned.plan.test.cmds[1])
    expect(planned.plan.build.cmds).toEqual(['npm run build'])
    expect(refuseArguments(run, planned.plan)).toBeNull()
  })

  it('refuses arguments for a task that reads secrets, and for a service', async () => {
    const files = bundle(build)
    const run = { tasks: ['test'], options: { args: ['-t', 'x'] } }
    expect(refuseArguments(run, (await planRun(files, run, hosted, policy)).plan)).toEqual(
      'test reads secrets (DB), it takes no arguments on a server: an argument could make it print them'
    )
    // a dependency that reads secrets does not get the arguments
    const yaml = `
tasks:
  login:
    image: node:22
    secrets:
      - { from: "gsm:npm-token", account: ci, env: NPM_TOKEN }
    cmds: [npm whoami]
  test:
    image: node:22
    deps: [login]
    cmds: [npx vitest run]
services:
  db:
    image: postgres:16
    cmd: postgres
`
    const test = { tasks: ['test'], options: { args: ['-t', 'x'] } }
    expect(refuseArguments(test, (await planRun(bundle(yaml), test, hosted, policy)).plan)).toBeNull()
    const db = { tasks: ['db'], options: { args: ['-c', 'fsync=off'] } }
    expect(refuseArguments(db, (await planRun(bundle(yaml), db, hosted, policy)).plan)).toEqual(
      'db is a service, arguments go to a task'
    )
  })

  it('refuses a version that reaches more than runs.network allows', async () => {
    const yaml = `
tasks:
  install:
    image: node:22
    network: { allow: [registry.npmjs.org, '*.githubusercontent.com'] }
    cmds: [npm ci]
  test:
    image: node:22
    network: none
    cmds: [npm test]
`
    const allow = (...hosts: string[]) => ({ ...policy, network: { type: 'allow' as const, hosts } })
    // open, the default, allows anything
    await expect(
      planBundle(bundle(yaml), hosted, { policy: { ...policy, network: { type: 'open' } } })
    ).resolves.toBeDefined()
    await expect(
      planBundle(bundle(yaml), hosted, { policy: allow('*.githubusercontent.com', 'registry.npmjs.org') })
    ).resolves.toBeDefined()
    // a wildcard of the server covers the names under it
    await expect(
      planBundle(bundle(yaml), hosted, { policy: allow('*.githubusercontent.com', '*.npmjs.org') })
    ).resolves.toBeDefined()
    await expect(planBundle(bundle(yaml), hosted, { policy: allow('registry.npmjs.org') })).rejects.toThrow(
      'install: asks for network allow *.githubusercontent.com, registry.npmjs.org, more than this server allows (runs.network: allow registry.npmjs.org)'
    )
    // a name of the server does not cover the wildcard of the build file
    await expect(
      planBundle(bundle(yaml), hosted, { policy: allow('raw.githubusercontent.com', 'registry.npmjs.org') })
    ).rejects.toThrow('install: asks for network')
    await expect(
      planBundle(bundle(yaml), hosted, { policy: { ...policy, network: { type: 'none' } } })
    ).rejects.toThrow(/^install: asks for network allow .*\(runs.network: none\)$/)
    // a task that asks for nothing passes, one that sets no network is open
    await expect(
      planBundle(bundle('tasks:\n  a:\n    image: node:22\n    network: none\n    cmds: [echo]\n'), hosted, {
        policy: { ...policy, network: { type: 'none' } },
      })
    ).resolves.toBeDefined()
    await expect(
      planBundle(bundle('tasks:\n  a:\n    image: node:22\n    cmds: [echo]\n'), hosted, {
        policy: { ...policy, network: { type: 'none' } },
      })
    ).rejects.toThrow('a: asks for network open, more than this server allows (runs.network: none)')
  })

  it('refuses a local task under a runs.network below open', async () => {
    await expect(
      planBundle(bundle('tasks:\n  a:\n    cmds: [echo]\n'), hosted, {
        policy: { ...policy, network: { type: 'allow', hosts: ['registry.npmjs.org'] } },
      })
    ).rejects.toThrow("a: is a local task, which can't be limited to the network this server allows")
  })

  it('requires every provider secret to name its account, a task account does not count', async () => {
    const yaml = `
tasks:
  deploy:
    account: prod
    secrets:
      - { from: "gsm:kube-token", env: KUBE_TOKEN }
    cmds: [./deploy.sh]
`
    await expect(planBundle(bundle(yaml), hosted, { policy })).rejects.toThrow(
      /secret KUBE_TOKEN: gsm:kube-token needs account: on the secret/
    )
  })

  it('refuses an account the server does not have, and lists the ones it has', async () => {
    const yaml = 'tasks:\n  a:\n    secrets:\n      - { from: "gsm:x", account: nope, env: X }\n    cmds: [echo]\n'
    await expect(planBundle(bundle(yaml), hosted, { policy })).rejects.toThrow(
      'unknown secret account nope, declared: ci, prod'
    )
  })

  it('refuses secret providers and accounts of the build file, they are the operator’s', async () => {
    const yaml = `
secretProviders:
  evil: { command: [cat, /etc/passwd] }
secretAccounts:
  mine: { providers: { evil: { env: {} } } }
tasks:
  a:
    cmds: [echo]
`
    await expect(planBundle(bundle(yaml), hosted, { policy })).rejects.toThrow(
      /declares secret providers or accounts, which a server defines in its own config/
    )
  })

  it('refuses a task whose runtime the server does not allow', async () => {
    const yaml = 'tasks:\n  a:\n    cmds: [echo]\n  b:\n    image: node:22\n    cmds: [echo]\n'
    await expect(planBundle(bundle(yaml), hosted, { policy: { ...policy, runtimes: ['docker'] } })).rejects.toThrow(
      'a: runs on the local runtime, which this server does not allow (runtimes: docker)'
    )
    await expect(planBundle(bundle(yaml), hosted, { policy: { ...policy, runtimes: ['local'] } })).rejects.toThrow(
      'b: runs on the docker runtime'
    )
    await expect(
      planBundle(bundle(yaml), hosted, { policy: { ...policy, runtimes: ['docker', 'local'] } })
    ).resolves.toMatchObject({ tasks: ['a', 'b'] })
  })

  it('refuses what points a build file at the host, a cluster or a remote cache', async () => {
    const refuse = async (yaml: string, message: string | RegExp) =>
      expect(planBundle(bundle(yaml), hosted, { policy })).rejects.toThrow(message)
    await refuse(
      'environments:\n  prod: { docker: { host: "tcp://evil:2375" } }\ntasks:\n  a:\n    cmds: [echo]\n',
      /environments pick a docker host or a Kubernetes cluster/
    )
    await refuse(
      'caches:\n  shared: { method: checksum, backend: { type: s3, bucket: b } }\ntasks:\n  a:\n    cmds: [echo]\n',
      /caches.shared: a server keeps its own cache/
    )
    await refuse(
      'caches:\n  shared: { method: checksum, backend: { type: local, path: /etc } }\ntasks:\n  a:\n    cmds: [echo]\n',
      /caches.shared/
    )
    await refuse(
      'services:\n  api:\n    kubeconfig: /home/x/.kube/config\n    selector: { app: api }\n    ports: [80]\ntasks:\n  a:\n    cmds: [echo]\n',
      /services.api: Kubernetes services are not supported on a server/
    )
    await refuse(
      'tasks:\n  a:\n    image: alpine\n    mounts: ["/var/run/docker.sock:/var/run/docker.sock"]\n    cmds: [echo]\n',
      'a: mounts /var/run/docker.sock, which is outside of the bundle'
    )
    await refuse(
      'tasks:\n  a:\n    image: alpine\n    mounts: ["../outside:/x"]\n    cmds: [echo]\n',
      /a: mounts .*outside, which is outside of the bundle/
    )
  })

  it('takes mounts inside the bundle', async () => {
    const yaml = 'tasks:\n  a:\n    image: alpine\n    mounts: ["./cache:/cache"]\n    cmds: [echo]\n'
    await expect(planBundle(bundle(yaml), hosted, { policy })).resolves.toMatchObject({ tasks: ['a'] })
  })

  it('refuses an account the server keeps for itself', async () => {
    const yaml = 'tasks:\n  a:\n    secrets:\n      - { from: "gsm:x", account: ci, env: X }\n    cmds: [echo]\n'
    await expect(planBundle(bundle(yaml), hosted, { policy: { ...policy, reserved: ['ci'] } })).rejects.toThrow(
      'a: the secret X is read as ci, which the server uses to read repositories'
    )
  })

  it('refuses secrets that read a file, or a variable the server does not list', async () => {
    const file = 'tasks:\n  a:\n    secrets:\n      - { from: "file:~/.ssh/id_rsa", env: KEY }\n    cmds: [echo]\n'
    await expect(planBundle(bundle(file), hosted, { policy })).rejects.toThrow(
      'a: a secret can not read a file of the server (file:), use a secret provider'
    )
    const env = 'tasks:\n  a:\n    secrets:\n      - { from: "env:SERVER_ONLY", env: X }\n    cmds: [echo]\n'
    await expect(planBundle(bundle(env), hosted, { policy })).rejects.toThrow(
      'the server does not list in runs.env.allow'
    )
    const listed = 'tasks:\n  a:\n    secrets:\n      - { from: "env:PATH", env: X }\n    cmds: [echo]\n'
    await expect(planBundle(bundle(listed), hosted, { policy })).resolves.toMatchObject({ tasks: ['a'] })
  })

  it('does not read the .env file of the project', async () => {
    // the reference of a secret is built from the envs of its task, which a .env file feeds
    const yaml = [
      'tasks:',
      '  a:',
      '    envs: { NAME: "${FROM_DOTENV}" }',
      '    secrets:',
      '      - { from: "gsm:${NAME}", account: ci, env: X }',
      '    cmds: [echo]',
      '',
    ].join('\n')
    const files = { '.env': 'FROM_DOTENV=leaked\n' }
    const planned = await planBundle(bundle(yaml, files), hosted, { policy })
    expect(planned.plan.a.secrets[0].from).not.toContain('leaked')
    // the same files do read it where there is no server
    const own =
      'secretProviders:\n  gsm: { command: [gcloud, "{{ref}}"] }\nsecretAccounts:\n  ci: { providers: { gsm: { env: {} } } }\n'
    const local = await planBundle(bundle(own + yaml, files), environmentMock(tmpdir()))
    expect(local.plan.a.secrets[0].from).toBe('gsm:leaked')
  })

  it('shows a build file that does not match the schema where it is wrong', async () => {
    const error = await planBundle(bundle('tasks:\n  a:\n    nope: 1\n'), hosted, { policy }).catch((e) => e)
    expect(error).toBeInstanceOf(DefinitionError)
    expect(error.message).toMatch(/tasks\.a/)
    expect(error.message).not.toContain(tmpdir())
  })
})

describe('planBundle on a machine without a server', () => {
  it('still reads the accounts of the build file itself', async () => {
    const yaml = `
secretProviders:
  gsm: { command: [gcloud, "{{ref}}"] }
secretAccounts:
  mine: { providers: { gsm: { env: {} } } }
tasks:
  a:
    secrets:
      - { from: "gsm:x", account: mine, env: X }
    cmds: [echo]
`
    // the bundle's own catalog needs a pinned source when it comes from a git include, not here
    const planned = await planBundle(bundle(yaml), environmentMock(tmpdir()))
    expect(planned.accounts).toEqual(['mine'])
  })
})
