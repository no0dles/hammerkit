import { join } from 'path'
import { readFileSync } from 'fs'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { requiresLinuxContainers } from '../requires-linux-containers'
import { expectSuccessfulResult } from '../expect'
import Dockerode from 'dockerode'
import { getBuildKitVolumeName } from '../../planner/image-build'

// A task with `build` on a dev machine: BuildKit, privileged, builds the Dockerfile, pulls its
// base image through the task's egress proxy, hands the proxy on to the RUN steps, and pushes
// the image and its layers to a registry:2 with basic auth, signed in with a login whose
// password is a secret. The registry is a service the task needs, which it reaches directly.

const USER = 'hammerkit'
const PASSWORD = 's3cret'
// `htpasswd -Bbn hammerkit s3cret`
const HTPASSWD = 'hammerkit:$2y$05$SCjSUAymt3iUPiqm1x5JhugaeTLDaO6eSiJ9h3lAITgwkNotaqhA2\n'

const DOCKER_HUB = [
  'registry-1.docker.io',
  'auth.docker.io',
  'production.cloudflare.docker.com',
  'production.cloudfront.docker.com',
  // where Docker Hub sends a request for a layer when neither CDN has it
  'docker-images-prod.s3.dualstack.us-east-1.amazonaws.com',
]

const registry = {
  image: 'registry:2.8.3',
  mounts: ['htpasswd:/auth/htpasswd'],
  envs: {
    REGISTRY_AUTH: 'htpasswd',
    REGISTRY_AUTH_HTPASSWD_REALM: 'hammerkit',
    REGISTRY_AUTH_HTPASSWD_PATH: '/auth/htpasswd',
  },
  healthcheck: { cmd: 'wget -q -O /dev/null http://127.0.0.1:5000/', timeout: '60s' },
}

// the digest the registry has for a tag, as the header of its manifest
const manifestDigest = (tag: string) =>
  `wget -S -q -O /dev/null --header "Authorization: Basic $(printf ${USER}:${PASSWORD} | base64)" ` +
  `--header "Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, ` +
  `application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json" ` +
  `http://registry:5000/v2/hello/manifests/${tag} 2>&1 | grep -i docker-content-digest | tr -d '\\r' | awk '{print $2}'`

// the manifest of a tag, a list of the images of each platform where there are several
const manifest = (tag: string) =>
  `wget -q -O - --header "Authorization: Basic $(printf ${USER}:${PASSWORD} | base64)" ` +
  `--header "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json" ` +
  `http://registry:5000/v2/hello/manifests/${tag}`

describe('image builds (docker)', () => {
  it(
    'builds a Dockerfile for two platforms, pushes it with a login and writes the digest of the image',
    requiresLinuxContainers(async () => {
      await createTestCase('image-build-docker', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        htpasswd: HTPASSWD,
        'app/Dockerfile': [
          'FROM alpine:3.21',
          // the RUN steps get the proxy as build args and its address as a host
          'RUN test -n "$HTTP_PROXY" && getent hosts hammerkit-proxy',
          // for each platform: the one of the machine, and arm64 in BuildKit's QEMU
          'RUN uname -m > /arch',
          'COPY hello.txt /hello.txt',
          '',
        ].join('\n'),
        'app/hello.txt': 'hello\n',
        '.hammerkit.yaml': {
          services: { registry },
          tasks: {
            image: {
              // the registry is new on every run: a cache hit would leave it empty
              cache: 'none',
              needs: ['registry'],
              build: {
                context: 'app',
                tags: 'registry:5000/hello:test',
                push: true,
                cache: 'registry:5000/hello:buildcache',
                digest: '.images/hello',
                insecure: true,
                platforms: ['linux/amd64', 'linux/arm64'],
                login: [{ registry: 'registry:5000', user: USER, password: { from: 'env:REGISTRY_PASSWORD' } }],
              },
              network: { allow: DOCKER_HUB },
            },
            check: {
              image: 'alpine:3.21',
              deps: ['image'],
              needs: ['registry'],
              cmds: [
                'grep -q "^registry:5000/hello@sha256:[0-9a-f]\\{64\\}$" .images/hello',
                `test "$(${manifestDigest('test')})" = "$(cut -d @ -f 2 .images/hello)"`,
                // one image for each platform under the name
                `${manifest('test')} | grep -q '"architecture": *"arm64"'`,
                `${manifest('test')} | grep -q '"architecture": *"amd64"'`,
                // the layers, which the next build reads
                `test -n "$(${manifestDigest('buildcache')})"`,
              ],
            },
          },
        },
      }).setup(async (cwd, environment) => {
        environment.processEnvs = { ...environment.processEnvs, REGISTRY_PASSWORD: PASSWORD }
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'check' })
        await expectSuccessfulResult(await cli.runExec(), environment)
        expect(readFileSync(join(cwd, '.images', 'hello'), 'utf8')).toMatch(
          /^registry:5000\/hello@sha256:[0-9a-f]{64}\n$/
        )

        // BuildKit kept its layers in a volume of the task, which clean removes
        const volume = getBuildKitVolumeName(cli.task('image').data)
        const docker = new Dockerode()
        await expect(docker.getVolume(volume).inspect()).resolves.toBeDefined()
        await cli.clean()
        await expect(docker.getVolume(volume).inspect()).rejects.toThrow()
      })
    }),
    300_000
  )
})
