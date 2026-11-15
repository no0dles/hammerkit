import { execFileSync } from 'child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { Cli } from '../cli'
import { ContainerWorkTask } from './work-task'
import { BUILDKIT_IMAGE, getImageBuildCommand, getImageName, WorkImageBuild } from './image-build'
import { environmentMock } from '../executer/environment-mock'
import { Environment } from '../executer/environment'
import { planBundle } from '../server/plan'
import { getSecretCatalog, serverConfigSchema } from '../server/server-config'
import { buildCreateOptions } from '../executer/docker-task'
import { getWorkTaskCacheDescription } from '../optimizer/work-task-cache-description'
import { getContainerBinds } from '../executer/get-container-binds'
import { WorkItem } from './work-item'
import { getKubernetesPersistence, getVolumeName } from '../kubernetes/volumes'
import { computeStateKey } from '../executer/scheduler/state-key'

async function withCli(name: string, buildFile: { [key: string]: unknown }, fn: (cli: Cli, cwd: string) => void) {
  await createTestCase(name, {
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.hammerkit.yaml': buildFile,
  }).setup(async (cwd, environment) => {
    fn(await createCli(join(cwd, '.hammerkit.yaml'), environment, {}), cwd)
  })
}

async function planError(name: string, buildFile: { [key: string]: unknown }): Promise<string> {
  try {
    await withCli(name, buildFile, () => undefined)
  } catch (e) {
    return JSON.stringify((e as any).zod?.issues ?? (e as Error).message)
  }
  throw new Error('expected an error')
}

const task = (cli: Cli, name: string) => cli.task(name).data as ContainerWorkTask

describe('image builds', () => {
  describe('build file', () => {
    it('makes a task with build the container task of BuildKit', async () => {
      await withCli(
        'image-build-plan',
        {
          envs: { REGISTRY: 'ghcr.io/acme' },
          tasks: {
            image: {
              build: {
                context: 'app',
                tags: ['$REGISTRY/app:1', '$REGISTRY/app:latest'],
                push: true,
                cache: '$REGISTRY/app:buildcache',
                digest: '.images/app',
                login: [{ registry: 'ghcr.io', user: 'ci', password: { from: 'env:GHCR_TOKEN' } }],
              },
            },
            plain: { build: {} },
            deploy: { image: 'alpine:3.21', deps: ['image'], cmds: ['cat .images/app'] },
          },
        },
        (cli, cwd) => {
          const image = task(cli, 'image')
          expect(image.type).toBe('container-task')
          expect(image.image).toBe(BUILDKIT_IMAGE)
          expect(image.capAdd).toEqual(['SYS_ADMIN'])
          // root: a capability holds for root only
          expect(image.user).toBeNull()
          expect(image.args).toBe(false)
          expect(image.build).toEqual({
            context: join(cwd, 'app'),
            dockerfile: join(cwd, 'app', 'Dockerfile'),
            tags: ['ghcr.io/acme/app:1', 'ghcr.io/acme/app:latest'],
            push: true,
            cache: 'ghcr.io/acme/app:buildcache',
            digest: join(cwd, '.images', 'app'),
            logins: [{ registry: 'ghcr.io', user: 'ci', passwordEnv: 'HAMMERKIT_REGISTRY_PASSWORD_0' }],
            insecure: false,
            platforms: [],
          })
          // what docker build sends: the context
          expect(image.src.map((s) => s.source)).toEqual(['app'])
          // the digest is a file, though it has no extension
          expect(image.generates.map((g) => ({ path: g.path, isFile: g.isFile }))).toEqual([
            { path: join(cwd, '.images', 'app'), isFile: true },
          ])
          expect(image.secrets.map((s) => [s.source, s.target])).toEqual([
            [
              { type: 'env', name: 'GHCR_TOKEN' },
              { type: 'env', name: 'HAMMERKIT_REGISTRY_PASSWORD_0' },
            ],
          ])
          expect(image.cmds).toHaveLength(1)

          const plain = task(cli, 'plain')
          expect(plain.build).toMatchObject({
            context: cwd,
            dockerfile: join(cwd, 'Dockerfile'),
            tags: [],
            push: false,
          })
          expect(plain.src.map((s) => s.source)).toEqual(['.'])
          expect(plain.generates).toEqual([])

          // the digest is there for the task that deploys the image
          expect(
            task(cli, 'deploy').generates.map((g) => ({ path: g.path, isFile: g.isFile, from: g.inherited?.name }))
          ).toEqual([{ path: join(cwd, '.images', 'app'), isFile: true, from: 'image' }])
        }
      )
    })

    it('reads the Dockerfile from outside the context, and the src the task lists instead of the context', async () => {
      await withCli(
        'image-build-src',
        {
          tasks: {
            outside: { build: { context: 'app', dockerfile: 'docker/app.Dockerfile' } },
            listed: { build: { dockerfile: 'app/Dockerfile' }, src: ['app/src', 'package.json'] },
          },
        },
        (cli) => {
          expect(task(cli, 'outside').src.map((s) => s.source)).toEqual(['app', 'docker/app.Dockerfile'])
          expect(task(cli, 'listed').src.map((s) => s.source)).toEqual(['app/src', 'package.json'])
        }
      )
    })

    it.each([
      ['an env', { envs: { BUILDKITD_FLAGS: '--debug' } }, 'BUILDKITD_FLAGS'],
      ['PATH', { envs: { PATH: '/tmp/bin' } }, 'PATH'],
      ['a secret', { secrets: [{ from: 'env:FLAGS', env: 'BUILDCTL' }] }, 'BUILDCTL'],
      ['the variable of a login', { envs: { HAMMERKIT_REGISTRY_PASSWORD_0: 'x' } }, 'HAMMERKIT_REGISTRY_PASSWORD_0'],
    ])('refuses %s that would change the command BuildKit runs', async (_, extra, name) => {
      const message = await planError('image-build-reserved-env', { tasks: { image: { build: {}, ...extra } } })
      expect(message).toContain(`${name} can't be set on a task with build`)
    })

    it('checks a login user a variable puts in', async () => {
      const message = await planError('image-build-login-user', {
        envs: { USER_NAME: 'a:b' },
        tasks: {
          image: {
            build: { login: [{ registry: 'ghcr.io', user: '$USER_NAME', password: { from: 'env:TOKEN' } }] },
          },
        },
      })
      expect(JSON.parse(message)).toContain('build login user "a:b" holds a colon')
    })

    it('builds a context a dependency generates from its output, not from the sources', async () => {
      await withCli(
        'image-build-generated-context',
        {
          tasks: {
            context: { image: 'alpine:3.21', generates: ['ctx'], cmds: ['mkdir -p ctx'] },
            image: { deps: ['context'], build: { context: 'ctx' } },
            nested: { deps: ['context'], build: { dockerfile: 'ctx/Dockerfile' }, src: ['ctx/app', 'package.json'] },
          },
        },
        (cli, cwd) => {
          // the folder is the output of `context`, bound into the task as it is into any that
          // depends on it, and stays the task's src, which keeps its id
          const image = cli.task('image') as WorkItem<ContainerWorkTask>
          expect(image.data.src.map((s) => s.source)).toEqual(['ctx'])
          expect(image.data.generates.map((g) => ({ path: g.path, from: g.inherited?.name }))).toEqual([
            { path: join(cwd, 'ctx'), from: 'context' },
          ])
          expect(getContainerBinds(image).filter((bind) => bind.containerPath === join(cwd, 'ctx'))).toEqual([
            { localPath: image.data.generates[0].volumeName, containerPath: join(cwd, 'ctx'), readOnly: false },
          ])
          const nested = cli.task('nested') as WorkItem<ContainerWorkTask>
          expect(nested.data.src.map((s) => s.source)).toEqual(['ctx/app', 'package.json'])
          expect(getContainerBinds(nested).map((bind) => bind.containerPath)).not.toContain(join(cwd, 'ctx', 'app'))
        }
      )
    })

    it('keeps the id of a task that depends on a container task generating a file', async () => {
      // a file a dep generates is handed on now; it stays out of the task's id, as before
      await withCli(
        'image-build-dep-id',
        {
          tasks: {
            make: { image: 'alpine:3.21', generates: ['out.txt'], cmds: ['echo a > out.txt'] },
            read: { image: 'alpine:3.21', deps: ['make'], cmds: ['cat out.txt'] },
          },
        },
        (cli) => {
          expect(task(cli, 'read').generates.map((g) => g.isFile)).toEqual([true])
          expect(getWorkTaskCacheDescription(cli.task('read')).generates).toEqual([])
        }
      )
    })

    // run_L89etEuo7JcJvUi1 of iwentsourcing: the image was a cache hit and its deploy, which has
    // no src of its own, rolled out the same digest again. One that lists the digest in its src
    // is keyed by the image it deploys, and the file is the image's output on a cluster too.
    it('keys a deploy that lists the digest of its image in src by the image, and mounts the digest once', async () => {
      await createTestCase('image-build-digest-src', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        Dockerfile: 'FROM scratch\n',
        '.hammerkit.yaml': {
          tasks: {
            image: { build: { tags: 'ghcr.io/acme/app:main', push: true, digest: '.images/app' }, src: ['Dockerfile'] },
            deploy: { image: 'alpine:3.21', deps: ['image'], src: ['.images/app'], cmds: ['cat .images/app'] },
          },
        },
      }).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {})
        const deploy = cli.task('deploy') as WorkItem<ContainerWorkTask>
        const digest = join(cwd, '.images', 'app')

        // bound once on docker, and mounted once on a cluster, from the claim of the image
        // and not uploaded from the checkout, where a server has no such file
        expect(getContainerBinds(deploy).filter((bind) => bind.containerPath === digest)).toEqual([
          { localPath: digest, containerPath: digest, readOnly: false },
        ])
        const persistence = await getKubernetesPersistence(deploy, {})
        expect(persistence.mounts.filter((m) => m.mount.mountPath === digest).map((m) => m.mount.name)).toEqual([
          getVolumeName(cli.task('image'), {}),
        ])
        expect(persistence.sources.map((source) => source.localPath)).not.toContain(digest)

        // provable, and keyed by what the image is built from, before and after it wrote the digest
        const before = await computeStateKey(cli.task('deploy'), 'checksum', environment)
        expect(before.provable).toBe(true)
        mkdirSync(join(cwd, '.images'))
        writeFileSync(digest, 'ghcr.io/acme/app@sha256:1\n')
        expect((await computeStateKey(cli.task('deploy'), 'checksum', environment)).stateKey).toBe(before.stateKey)
        writeFileSync(join(cwd, 'Dockerfile'), 'FROM alpine\n')
        expect((await computeStateKey(cli.task('deploy'), 'checksum', environment)).stateKey).not.toBe(before.stateKey)
      })
    })

    it.each<[string, { [key: string]: unknown }, RegExp]>([
      ['image-build-push-no-tags', { build: { push: true } }, /push needs tags/],
      ['image-build-digest-no-tags', { build: { digest: 'out' } }, /digest needs tags/],
      ['image-build-bad-tag', { build: { tags: 'acme app' } }, /a tag must be an image name/],
      ['image-build-bad-platform', { build: { platforms: ['arm64'] } }, /a platform is os\/arch/],
      ['image-build-unknown', { build: { tag: 'app' } }, /Unrecognized key.*tag/],
      ['image-build-image', { build: {}, image: 'alpine' }, /Unrecognized key.*image/],
      ['image-build-cmds', { build: {}, cmds: ['echo'] }, /Unrecognized key.*cmds/],
      [
        'image-build-login-user',
        { build: { login: [{ registry: 'ghcr.io', user: 'a:b', password: { from: 'env:X' } }] } },
        /user must not hold a colon/,
      ],
      [
        'image-build-login-registry',
        { build: { login: [{ registry: 'https://ghcr.io', user: 'a', password: { from: 'env:X' } }] } },
        /registry must be a host/,
      ],
    ])('refuses %s', async (name, image, error) => {
      expect(await planError(name, { tasks: { image } })).toMatch(error)
    })

    it('refuses a tag that a variable makes no image name', async () => {
      expect(
        await planError('image-build-env-tag', {
          envs: { TAG: 'a,push=false' },
          tasks: { image: { build: { tags: 'app:$TAG' } } },
        })
      ).toMatch(/build tag \\"app:a,push=false\\" is no image name/)
    })

    it('refuses to extend a task that builds an image', async () => {
      expect(
        await planError('image-build-extend', {
          tasks: { image: { build: {} }, other: { extend: 'image', cmds: ['echo'] } },
        })
      ).toMatch(/other extends image, which builds an image/)
    })
  })

  describe('on a dev machine', () => {
    it('runs BuildKit privileged, with a volume of its own for the layers', async () => {
      await withCli('image-build-docker-options', { tasks: { image: { build: {} } } }, (cli) => {
        const item = cli.task('image') as any
        const local = buildCreateOptions(
          item,
          'state',
          { networkMode: 'bridge', env: {} } as any,
          environmentMock(tmpdir()),
          {
            env: {},
            binds: [],
          }
        )
        expect(local.HostConfig).toMatchObject({ Privileged: true, CapAdd: ['SYS_ADMIN'] })
        expect(local.HostConfig?.Binds).toContainEqual(
          expect.stringMatching(/^hammerkit-[0-9a-f]{40}:\/var\/lib\/buildkit$/)
        )

        // on a server's docker host: SYS_ADMIN in the sandboxed runtime, a tmpfs of the command
        const hosted: Environment = {
          ...environmentMock(tmpdir()),
          hosted: { catalog: {} as any, capabilityRuntime: 'runsc' },
        }
        const server = buildCreateOptions(item, 'state', { networkMode: 'bridge', env: {} } as any, hosted, {
          env: {},
          binds: [],
        })
        expect(server.HostConfig).toMatchObject({ CapAdd: ['SYS_ADMIN'], Runtime: 'runsc' })
        expect(server.HostConfig?.Privileged).toBeUndefined()
        expect(server.HostConfig?.Binds?.some((bind) => bind.endsWith(':/var/lib/buildkit'))).toBe(false)
      })
    })
  })

  describe('on a server', () => {
    const config = serverConfigSchema.parse({
      issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit' }],
      secretProviders: { 'gcp-token': { command: ['gcloud', 'auth', 'print-access-token'] } },
      accounts: { push: { providers: { 'gcp-token': { env: {} } } } },
    })
    const hosted: Environment = {
      ...environmentMock(tmpdir()),
      processEnvs: { PATH: '/bin' },
      hosted: { catalog: getSecretCatalog(config) },
    }
    const yaml = `
tasks:
  image:
    build:
      tags: europe-west4-docker.pkg.dev/acme/apps/app:main
      push: true
      login:
        - registry: europe-west4-docker.pkg.dev
          user: oauth2accesstoken
          password: { from: 'gcp-token:push', account: push }
`
    const bundle = { entry: '.hammerkit.yaml', files: { '.hammerkit.yaml': yaml } }

    it('needs SYS_ADMIN of the server, and reads the password as the account of its login', async () => {
      await expect(planBundle(bundle, hosted, { policy: { envs: ['PATH'], capabilities: [] } })).rejects.toThrow(
        'image: adds the capability SYS_ADMIN, and this server allows none (backend.capabilities.allow)'
      )
      const planned = await planBundle(bundle, hosted, { policy: { envs: ['PATH'], capabilities: ['SYS_ADMIN'] } })
      expect(planned.accounts).toEqual(['push'])
      expect(planned.plan.image).toMatchObject({ image: BUILDKIT_IMAGE, capAdd: ['SYS_ADMIN'] })
    })
  })

  // the command runs in BuildKit's Linux container: Windows has no /bin/sh to run it with
  describe.skipIf(process.platform === 'win32')('the command', () => {
    let dir = ''
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'hammerkit-image-build-'))
    })
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    // Runs the command with stand-ins for BuildKit, mount and getent, which record how they were
    // called: what each got is in `out`.
    function run(build: Partial<WorkImageBuild>, env: { [key: string]: string } = {}) {
      const bin = join(dir, 'bin')
      const out = join(dir, 'out')
      const cwd = join(dir, 'project')
      mkdirSync(bin)
      mkdirSync(out)
      mkdirSync(cwd)
      const fake = (name: string, script: string) => {
        writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`)
        chmodSync(join(bin, name), 0o755)
      }
      fake(
        'buildctl-daemonless.sh',
        [
          `for arg in "$@"; do printf '%s\\n' "$arg"; done > ${out}/args`,
          `cp "$DOCKER_CONFIG/config.json" ${out}/config.json 2>/dev/null || true`,
          `printf '%s|%s|%s' "$BUILDCTL" "$BUILDKITD" "$BUILDKITD_FLAGS" > ${out}/buildkit-env`,
          'while [ "$#" -gt 0 ]; do if [ "$1" = --metadata-file ]; then file="$2"; fi; shift; done',
          `printf '{"containerimage.digest": "sha256:%s"}' "$(printf a%.0s $(seq 64))" > "$file"`,
        ].join('\n')
      )
      fake('mount', `echo "$@" > ${out}/mount`)
      // the proxy's name resolves where the task has one, as the proxy is there then
      fake('getent', `[ -n "$HTTP_PROXY" ] && [ "$2" = hammerkit-proxy ] && echo '10.1.2.3   hammerkit-proxy'`)
      const full: WorkImageBuild = {
        context: cwd,
        dockerfile: join(cwd, 'Dockerfile'),
        tags: [],
        push: false,
        cache: null,
        digest: null,
        logins: [],
        insecure: false,
        platforms: [],
        ...build,
      }
      execFileSync('/bin/sh', ['-c', getImageBuildCommand(cwd, full)], {
        cwd,
        env: { PATH: `${bin}:/usr/bin:/bin`, ...env },
        stdio: 'pipe',
      })
      const read = (name: string) => {
        try {
          return readFileSync(join(out, name), 'utf8')
        } catch {
          return null
        }
      }
      return {
        args: read('args')?.trim().split('\n') ?? [],
        config: read('config.json'),
        mount: read('mount'),
        buildkitEnv: read('buildkit-env'),
        cwd,
      }
    }

    it('builds the Dockerfile of the context, in a tmpfs, with nothing else', () => {
      const result = run({})
      expect(result.mount?.trim()).toBe('-t tmpfs tmpfs /var/lib/buildkit')
      expect(result.args).toEqual([
        'build',
        '--progress',
        'plain',
        '--frontend',
        'dockerfile.v0',
        '--local',
        'context=.',
        '--local',
        'dockerfile=.',
        '--opt',
        'filename=Dockerfile',
        '--metadata-file',
        '/tmp/hammerkit-build.json',
      ])
      expect(result.config).toBeNull()
    })

    it('signs in, pushes the tags, reads and writes the cache, and writes the digest', () => {
      const result = run(
        {
          context: join(dir, 'project', 'app'),
          dockerfile: join(dir, 'project', 'docker', 'app.Dockerfile'),
          tags: ['ghcr.io/acme/app:1', 'ghcr.io/acme/app:latest'],
          push: true,
          cache: 'ghcr.io/acme/app:buildcache',
          digest: join(dir, 'project', '.images', 'app'),
          logins: [
            { registry: 'ghcr.io', user: 'ci', passwordEnv: 'HAMMERKIT_REGISTRY_PASSWORD_0' },
            { registry: 'docker.io', user: 'acme', passwordEnv: 'HAMMERKIT_REGISTRY_PASSWORD_1' },
          ],
        },
        // as a provider prints them, with a newline
        { HAMMERKIT_REGISTRY_PASSWORD_0: 'secret-token\n', HAMMERKIT_REGISTRY_PASSWORD_1: "it's\n" }
      )
      expect(result.args).toEqual([
        'build',
        '--progress',
        'plain',
        '--frontend',
        'dockerfile.v0',
        '--local',
        'context=app',
        '--local',
        'dockerfile=docker',
        '--opt',
        'filename=app.Dockerfile',
        '--import-cache',
        'type=registry,ref=ghcr.io/acme/app:buildcache',
        '--export-cache',
        'type=registry,ref=ghcr.io/acme/app:buildcache,mode=max',
        '--output',
        'type=image,"name=ghcr.io/acme/app:1,ghcr.io/acme/app:latest",push=true',
        '--metadata-file',
        '/tmp/hammerkit-build.json',
      ])
      const auth = (user: string, password: string) => Buffer.from(`${user}:${password}`).toString('base64')
      expect(JSON.parse(result.config ?? '')).toEqual({
        auths: {
          'ghcr.io': { auth: auth('ci', 'secret-token') },
          'https://index.docker.io/v1/': { auth: auth('acme', "it's") },
        },
      })
      expect(readFileSync(join(result.cwd, '.images', 'app'), 'utf8')).toBe(
        `ghcr.io/acme/app@sha256:${'a'.repeat(64)}\n`
      )
    })

    it("runs BuildKit's own programs, whatever the environment names", () => {
      const result = run(
        {},
        { BUILDCTL: 'touch /tmp/pwned; buildctl', BUILDKITD_FLAGS: '--oci-worker-no-process-sandbox' }
      )
      expect(result.buildkitEnv).toBe('buildctl|buildkitd|')
    })

    it('builds for each platform under one name', () => {
      const result = run({ tags: ['ghcr.io/acme/app:1'], push: true, platforms: ['linux/amd64', 'linux/arm64'] })
      expect(result.args).toEqual(expect.arrayContaining(['--opt', 'platform=linux/amd64,linux/arm64']))
    })

    it('hands the egress proxy on to the RUN steps', () => {
      const result = run(
        { tags: ['registry:5000/app'], insecure: true, cache: 'registry:5000/app:cache' },
        { HTTP_PROXY: 'http://hammerkit-proxy:3128', https_proxy: 'http://hammerkit-proxy:3128', NO_PROXY: 'a,b' }
      )
      expect(result.args).toEqual(
        expect.arrayContaining([
          'build-arg:HTTP_PROXY=http://hammerkit-proxy:3128',
          'build-arg:https_proxy=http://hammerkit-proxy:3128',
          'build-arg:NO_PROXY=a,b',
          'add-hosts=hammerkit-proxy=10.1.2.3',
          'type=registry,ref=registry:5000/app:cache,registry.insecure=true',
          'type=registry,ref=registry:5000/app:cache,mode=max,registry.insecure=true',
          'type=image,name=registry:5000/app,push=false,registry.insecure=true',
        ])
      )
      expect(result.args.filter((arg) => arg.startsWith('build-arg:'))).toHaveLength(3)
    })
  })

  it.each([
    ['ghcr.io/acme/app:1', 'ghcr.io/acme/app'],
    ['localhost:5000/app', 'localhost:5000/app'],
    ['localhost:5000/app:dev', 'localhost:5000/app'],
    ['app@sha256:abc', 'app'],
    ['app', 'app'],
  ])('names %s as %s', (image, name) => {
    expect(getImageName(image)).toBe(name)
  })
})
