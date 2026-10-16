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
      serverEnvs: [],
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

  it('refuses arguments for a run in which an item reads a secret or a variable of the server', async () => {
    const refusal = async (yaml: string, task: string) => {
      const run = { tasks: [task], options: { args: ['-t', 'x'] } }
      return refuseArguments(run, (await planRun(bundle(yaml), run, hosted, policy)).plan)
    }
    expect(await refusal(build, 'test')).toEqual(
      'test reads the secret DB, it takes no arguments on a server: an argument could make it print them'
    )
    const yaml = `
services:
  signer:
    image: node:22
    cmd: node sign.js
    secrets:
      - { from: "gsm:signing-key", account: ci, env: KEY }
tasks:
  login:
    image: node:22
    secrets:
      - { from: "gsm:npm-token", account: ci, env: NPM_TOKEN }
    cmds: [npm whoami]
  test:
    image: node:22
    deps: [login]
    needs: [signer]
    cmds: [npx vitest run]
  token:
    image: node:22
    envs: { TOKEN: $SERVER_ONLY, URL: "https://\${SERVER_ONLY}@registry" }
    cmds: [npm ci]
  plain:
    image: node:22
    envs: { P: $PATH, BIN: "\${PATH}/x" }
    cmds: [npm test]
`
    // what a dependency or a service of the run holds reaches the task: the dependency through
    // its outputs, the service through its answers
    expect(await refusal(yaml, 'test')).toEqual(
      'test takes no arguments on a server: login in its run reads the secret NPM_TOKEN, and an argument could make test print what login hands on'
    )
    const needs = `
services:
  signer:
    image: node:22
    cmd: node sign.js
    secrets:
      - { from: "gsm:signing-key", account: ci, env: KEY }
tasks:
  registry:
    image: node:22
    envs: { TOKEN: $SERVER_ONLY }
    cmds: [npm ci]
  sign:
    image: node:22
    needs: [signer]
    cmds: [node client.js]
  install:
    image: node:22
    deps: [registry]
    cmds: [npm test]
`
    expect(await refusal(needs, 'sign')).toEqual(
      'sign takes no arguments on a server: signer in its run reads the secret KEY, and an argument could make sign print what signer hands on'
    )
    expect(await refusal(needs, 'install')).toEqual(
      'install takes no arguments on a server: registry in its run reads $SERVER_ONLY of the server, and an argument could make install print what registry hands on'
    )
    // a variable of the server can be a credential as well, as `$NAME` or `${NAME}`
    expect(await refusal(yaml, 'token')).toEqual(
      'token reads $SERVER_ONLY of the server, it takes no arguments on a server: an argument could make it print them'
    )
    // where tools are is not a credential
    expect(await refusal(yaml, 'plain')).toBeNull()
    expect(await refusal(yaml, 'signer')).toEqual('signer is not a task of this version')
    expect(await refusal(yaml, 'nope')).toEqual('nope is not a task of this version')
  })

  it('records the variables of the server each item reads', async () => {
    const yaml =
      'tasks:\n  a:\n    image: node:22\n    envs: { A: $SERVER_ONLY, B: "${PATH}:x", C: literal }\n    cmds: [echo]\n'
    expect((await planBundle(bundle(yaml), hosted, { policy })).plan.a.serverEnvs).toEqual(['PATH', 'SERVER_ONLY'])
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
    // a redundant name of the server takes nothing from a task that asks for exactly what it allows
    await expect(
      planBundle(bundle(yaml), hosted, {
        policy: allow('*.githubusercontent.com', 'raw.githubusercontent.com', 'registry.npmjs.org'),
      })
    ).resolves.toBeDefined()
    // a name of the server does not cover the wildcard of the build file
    await expect(
      planBundle(bundle(yaml), hosted, { policy: allow('raw.githubusercontent.com', 'registry.npmjs.org') })
    ).rejects.toThrow('install: asks for network')
    await expect(
      planBundle(bundle(yaml), hosted, { policy: { ...policy, network: { type: 'none' } } })
    ).rejects.toThrow(/^install: asks for network allow .*\(runs.network: none\)$/)
    // an empty allow list reaches nothing; a task that asks for nothing passes, one that sets no network is open
    await expect(
      planBundle(bundle('tasks:\n  a:\n    image: node:22\n    network: { allow: [] }\n    cmds: [echo]\n'), hosted, {
        policy: { ...policy, network: { type: 'none' } },
      })
    ).resolves.toBeDefined()
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
    // services are held to it as well, whether a task needs them or not
    const services = (network: string) =>
      `services:\n  api:\n    image: node:22\n    cmd: node server.js${network}\ntasks:\n  a:\n    image: node:22\n    network: none\n    cmds: [echo]\n`
    await expect(
      planBundle(bundle(services('')), hosted, { policy: { ...policy, network: { type: 'none' } } })
    ).rejects.toThrow('api: asks for network open, more than this server allows (runs.network: none)')
    await expect(
      planBundle(bundle(services('\n    network: none')), hosted, { policy: { ...policy, network: { type: 'none' } } })
    ).resolves.toBeDefined()
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

  it('refuses on a cluster what the Job of a task can not read itself yet', async () => {
    const onCluster = { policy: { ...policy, backend: 'kubernetes' as const } }
    const cached =
      'tasks:\n  a:\n    secrets:\n      - { from: "gsm:x", account: ci, env: X, cache: true }\n    cmds: [echo]\n'
    await expect(planBundle(bundle(cached), hosted, onCluster)).rejects.toThrow(
      'a: the secret X has cache: true, its digest would need the value before the Job of the task reads it'
    )
    const service =
      'services:\n  db:\n    image: postgres:16\n    secrets:\n      - { from: "gsm:x", account: ci, env: X }\n'
    await expect(planBundle(bundle(service), hosted, onCluster)).rejects.toThrow(
      'db: the secret X is read from gsm, which this server does for tasks only'
    )
    const offline =
      'tasks:\n  a:\n    image: alpine:3.19\n    network: none\n    secrets:\n      - { from: "gsm:x", account: ci, env: X }\n    cmds: [echo]\n'
    await expect(planBundle(bundle(offline), hosted, onCluster)).rejects.toThrow(
      'a: the secret X is read from gsm in the Job of the task, which network none would cut off from it'
    )
    await expect(planBundle(bundle(build), hosted, onCluster)).resolves.toBeTruthy()
    await expect(planBundle(bundle(cached), hosted, { policy })).resolves.toBeTruthy()
    await expect(planBundle(bundle(offline), hosted, { policy })).resolves.toBeTruthy()
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
    // what a task reads would be uploaded or bound from the server: its cluster token
    await refuse(
      'tasks:\n  a:\n    image: alpine\n    src: ["../../../../../../var/run/secrets/kubernetes.io/serviceaccount"]\n    cmds: [echo]\n',
      'a: src ../../../../../../var/run/secrets/kubernetes.io/serviceaccount is outside of the bundle'
    )
    await refuse('tasks:\n  a:\n    src: ["../../**/*.conf"]\n    cmds: [echo]\n', 'a: src ../../**/*.conf is outside')
    await refuse(
      'tasks:\n  a:\n    image: alpine\n    generates: ["../out"]\n    cmds: [echo]\n',
      /a: generates .*out, which is outside of the bundle/
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
