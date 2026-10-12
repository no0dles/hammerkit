import { execFileSync, spawnSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { environmentMock } from '../executer/environment-mock'
import { WorkKubernetesServer } from '../planner/work-environment'
import { WorkSecret } from '../planner/work-secret'
import { getJobSecretSpec, JobSecretSpec, splitJobSecrets } from './job-secrets'

const server: WorkKubernetesServer = {
  run: 'run_1',
  namespace: 'hammerkit',
  pools: [],
  providers: { echo: { image: 'busybox:1.36' } },
  accounts: { dev: { serviceAccount: 'dev' }, ops: { secret: 'ops-files' } },
}

function provider(ref: string, account: string, target: WorkSecret['target']): WorkSecret {
  return {
    source: {
      type: 'provider',
      provider: 'echo',
      ref,
      account,
      binding: {
        definition: {
          name: 'echo',
          type: 'command',
          command: ['printf', '%s', '{{ref}}'],
          env: { REGION: 'eu' },
          timeoutMs: 1000,
          declaredIn: 'the server config',
        },
        account: { name: account, env: { CREDENTIALS: '/var/run/hammerkit/account/key.json' } },
      },
    },
    target,
    cache: false,
    digest: () => '',
  }
}

const item = { name: 'deploy', id: () => 'abc' } as any
const credentials = {
  dev: [{ key: 'dev.token', path: 'token' }],
  ops: [{ key: 'ops.file.key.json', path: 'key.json' }],
}

describe('secrets read in the Job', () => {
  const secrets = [
    provider('the-token-value', 'dev', { type: 'env', name: 'TOKEN' }),
    {
      ...provider('x', 'dev', { type: 'env', name: 'X' }),
      source: { type: 'env', name: 'SERVER_VALUE' },
    } as WorkSecret,
    provider("multi'line\nsecond-line\n", 'ops', { type: 'env', name: 'KEY' }),
    provider('file-value', 'ops', { type: 'file', path: '/run/secrets/key' }),
  ]

  it('reads the secrets of providers in the Job, and hands over the server’s own as before', () => {
    const { delivered, inJob } = splitJobSecrets(secrets, server)
    expect(delivered).toEqual([secrets[1]])
    expect(inJob.map((s) => [s.index, s.source.ref])).toEqual([
      [0, 'the-token-value'],
      [1, "multi'line\nsecond-line\n"],
      [2, 'file-value'],
    ])
    expect(splitJobSecrets(secrets, undefined)).toEqual({ delivered: secrets, inJob: [] })
  })

  it('gives each init container its provider’s image and variables and only its account’s credential', () => {
    const { inJob } = splitJobSecrets(secrets, server)
    const spec = getJobSecretSpec(item, inJob, server, credentials, environmentMock(tmpdir()))
    expect(spec.initContainers.map((c) => [c.name, c.image, c.args])).toEqual([
      ['secret-0', 'busybox:1.36', ['sh', 'printf', '%s', 'the-token-value']],
      ['secret-1', 'busybox:1.36', ['sh', 'printf', '%s', "multi'line\nsecond-line\n"]],
      ['secret-2', 'busybox:1.36', ['sh', 'printf', '%s', 'file-value']],
    ])
    expect(spec.initContainers[0].env).toEqual([
      { name: 'REGION', value: 'eu' },
      { name: 'CREDENTIALS', value: '/var/run/hammerkit/account/key.json' },
      { name: 'HAMMERKIT_VALUE', value: '/var/run/hammerkit/secrets/secret-0' },
    ])
    expect(spec.initContainers.map((c) => c.volumeMounts?.map((m) => m.name))).toEqual([
      ['hammerkit-secret-values', 'hammerkit-account-0'],
      ['hammerkit-secret-values', 'hammerkit-account-1'],
      ['hammerkit-secret-values', 'hammerkit-account-1'],
    ])
    expect(spec.volumes).toEqual([
      { name: 'hammerkit-secret-values', emptyDir: { medium: 'Memory' } },
      {
        name: 'hammerkit-account-0',
        secret: { secretName: 'deploy-abc-credentials', items: credentials.dev, defaultMode: 0o444 },
      },
      {
        name: 'hammerkit-account-1',
        secret: { secretName: 'deploy-abc-credentials', items: credentials.ops, defaultMode: 0o444 },
      },
    ])
    // the task sees the values, never the credentials
    expect(spec.mounts).toEqual([
      { name: 'hammerkit-secret-values', mountPath: '/var/run/hammerkit/secrets' },
      { name: 'hammerkit-secret-values', mountPath: '/run/secrets/key', subPath: 'secret-2', readOnly: true },
    ])
  })

  it('refuses an account the run was not admitted for, and a provider without an image', () => {
    const { inJob } = splitJobSecrets(secrets, server)
    const admitted = { ...environmentMock(tmpdir()), hosted: { catalog: {} as any, accounts: ['dev'] } }
    expect(() => getJobSecretSpec(item, inJob, server, credentials, admitted)).toThrow('secret KEY (echo:multi')
    expect(() =>
      getJobSecretSpec(item, inJob, { ...server, providers: {} }, credentials, environmentMock(tmpdir()))
    ).toThrow('this server names no image for the provider echo')
  })

  it('keeps the command as it is for a task without such secrets', () => {
    const spec = getJobSecretSpec(item, [], server, {}, environmentMock(tmpdir()))
    expect(spec.command('/bin/sh', 'echo hi')).toEqual({ command: ['/bin/sh', '-c'], args: ['echo hi'], env: [] })
    expect(spec.initContainers).toEqual([])
  })

  // what the containers do, with this machine's shell and awk standing in for the pod's
  const itPosix = process.platform === 'win32' ? it.skip : it
  itPosix('exports the values verbatim, masks them in the output and keeps the exit code', () => {
    const { inJob } = splitJobSecrets(secrets, server)
    const spec: JobSecretSpec = getJobSecretSpec(item, inJob, server, credentials, environmentMock(tmpdir()))
    const directory = mkdtempSync(join(tmpdir(), 'hammerkit-job-secrets-'))
    try {
      for (const [index, init] of spec.initContainers.entries()) {
        const env = Object.fromEntries((init.env ?? []).map((e) => [e.name, e.value ?? '']))
        execFileSync(init.command?.[0] ?? '', [...(init.command ?? []).slice(1), ...(init.args ?? [])], {
          env: { PATH: process.env.PATH, ...env, HAMMERKIT_VALUE: join(directory, `secret-${index}`) },
        })
      }
      const command = spec.command(
        '/bin/sh',
        'echo "token=$TOKEN"; printf "%s" "$KEY" | od -c | tr -s " " | head -2; echo "key=$KEY" >&2; exit 3'
      )
      const env = Object.fromEntries(command.env.map((e) => [e.name, e.value ?? '']))
      const result = spawnSync(command.command[0], [...command.command.slice(1), ...command.args], {
        env: { PATH: process.env.PATH, ...env, HAMMERKIT_SECRETS: directory },
        encoding: 'utf8',
      })
      expect(result.status).toBe(3)
      expect(result.stdout).toContain('token=***')
      expect(result.stdout).toContain('key=***\n***')
      expect(result.stdout).not.toContain('the-token-value')
      expect(result.stdout).not.toContain('second-line')
      // the trailing newline of the value is kept
      expect(result.stdout).toMatch(/e \\n/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
