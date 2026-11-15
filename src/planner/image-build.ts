import { dirname, isAbsolute, join, posix, relative, sep } from 'path'
import { BuildFileImageBuildSchema } from '../schema/build-file-image-build-schema'
import { BuildFileSecretSchema } from '../schema/build-file-secret-schema'
import { BuildFileVolumeSchema } from '../schema/build-file-volume-schema'
import { WorkEnvironmentVariables } from '../environment/replace-env-variables'
import { templateValue } from './utils/template-value'
import { getVolumeName } from './utils/plan-work-volume'
import { EGRESS_PROXY_HOST } from '../network/egress-proxy'

// A task with `build` is a container task hammerkit writes itself: BuildKit, without a
// daemon, in this image. BuildKit mounts the layers it builds, which needs SYS_ADMIN: a
// server adds it only in a sandboxed runtime (backend.capabilities), and on a dev machine the
// container runs privileged, as `docker buildx` runs its own BuildKit. Pinned, so a build
// file builds with the same BuildKit everywhere; bumping it changes the id of every such task.
export const BUILDKIT_IMAGE = 'moby/buildkit:v0.25.1'

// Where BuildKit keeps its layers. On a server it is a tmpfs the command mounts (gVisor
// can't mount the layers on the container's own file system); on a dev machine a volume of
// the task, so the layers are there for the next build.
export const BUILDKIT_STATE = '/var/lib/buildkit'

// The variable the password of each login is in, as an env secret of the task. Not a file: a
// file secret is a subPath mount of the volume the secrets are written to, and a sandbox such
// as gVisor keeps that volume (in memory) inside the sandbox, where the host's mount doesn't see
// the file and makes a folder of it.
const LOGIN_ENV = 'HAMMERKIT_REGISTRY_PASSWORD_'

// BuildKit's report of the build, where the digest of the image is
const METADATA_FILE = '/tmp/hammerkit-build.json'

export interface WorkImageBuild {
  // absolute paths
  context: string
  dockerfile: string
  tags: string[]
  push: boolean
  cache: string | null
  digest: string | null
  logins: WorkRegistryLogin[]
  insecure: boolean
  // empty: the platform of the machine BuildKit runs on
  platforms: string[]
}

export interface WorkRegistryLogin {
  registry: string
  user: string
  // the env secret of the task holding the password
  passwordEnv: string
}

const IMAGE = /^[a-z0-9][a-z0-9._/:@-]*$/i

// The build of a task, with the values of its envs in place
export function parseWorkImageBuild(
  cwd: string,
  build: BuildFileImageBuildSchema,
  envs: WorkEnvironmentVariables,
  taskName: string
): WorkImageBuild {
  // checked here, not in the schema: a base of `extend` may set push for tasks that set their tags
  const needsTags = build.push ? 'push' : build.digest !== undefined ? 'digest' : null
  if (needsTags && build.tags === undefined) {
    throw new Error(`task ${taskName}: build ${needsTags} needs tags, the names of the image`)
  }
  const context = join(cwd, templateValue(build.context ?? '.', envs))
  const dockerfile = build.dockerfile ? join(cwd, templateValue(build.dockerfile, envs)) : join(context, 'Dockerfile')
  const tags = (build.tags === undefined ? [] : Array.isArray(build.tags) ? build.tags : [build.tags]).map((tag) =>
    checkImage(templateValue(tag, envs), 'tag', taskName)
  )
  return {
    context,
    dockerfile,
    tags,
    push: build.push ?? false,
    cache: build.cache ? checkImage(templateValue(build.cache, envs), 'cache', taskName) : null,
    digest: build.digest ? join(cwd, templateValue(build.digest, envs)) : null,
    logins: (build.login ?? []).map((login, index) => ({
      registry: templateValue(login.registry, envs),
      user: checkUser(templateValue(login.user, envs), taskName),
      passwordEnv: `${LOGIN_ENV}${index}`,
    })),
    insecure: build.insecure ?? false,
    platforms:
      build.platforms === undefined ? [] : Array.isArray(build.platforms) ? build.platforms : [build.platforms],
  }
}

// a user of basic auth, as the schema checks the build file's own value
function checkUser(value: string, taskName: string): string {
  if (!/^[^:"\\\s]+$/.test(value)) {
    throw new Error(
      `task ${taskName}: build login user ${JSON.stringify(value)} holds a colon, a quote, a backslash or a space`
    )
  }
  return value
}

// a value put in with $NAME is checked as the build file's own value is
function checkImage(value: string, field: string, taskName: string): string {
  if (!IMAGE.test(value)) {
    throw new Error(`task ${taskName}: build ${field} ${JSON.stringify(value)} is no image name`)
  }
  return value
}

// Names the task can't set: BuildKit's own script runs the programs and flags these name, and
// the command runs from PATH, in a container that is privileged on a dev machine. Hammerkit
// writes the command of the build, not the build file.
const RESERVED_ENV = /^(PATH|LD_[A-Z0-9_]*|BUILDKIT[A-Z0-9_]*|BUILDCTL[A-Z0-9_]*|HAMMERKIT_REGISTRY_[A-Z0-9_]*)$/

export function checkImageBuildEnvs(names: string[], taskName: string): void {
  const reserved = names.filter((name) => RESERVED_ENV.test(name))
  if (reserved.length > 0) {
    throw new Error(
      `task ${taskName}: ${reserved.join(
        ', '
      )} can't be set on a task with build, which runs BuildKit as hammerkit writes it`
    )
  }
}

// The passwords of the logins, as env secrets of the task
export function getImageBuildSecrets(build: BuildFileImageBuildSchema): BuildFileSecretSchema[] {
  return (build.login ?? []).map((login, index) => ({
    from: login.password.from,
    ...(login.password.account ? { account: login.password.account } : {}),
    env: `${LOGIN_ENV}${index}`,
  }))
}

// What the build reads when the task doesn't list `src`: its context, as `docker build` sends
// it, and the Dockerfile where that is outside of it.
export function getImageBuildSources(cwd: string, build: WorkImageBuild): string[] {
  const context = toPosix(relative(cwd, build.context)) || '.'
  return isInside(build.context, build.dockerfile) ? [context] : [context, toPosix(relative(cwd, build.dockerfile))]
}

// The file the digest is written to is an output of the task. It is a file whatever its name
// (see parseWorkGenerate): without an extension it would be taken for a folder.
export function getImageBuildGenerates(cwd: string, build: WorkImageBuild): BuildFileVolumeSchema[] {
  return build.digest ? [toPosix(relative(cwd, build.digest))] : []
}

// The volume a build keeps its layers in on a dev machine, one per task, as two BuildKits
// can't share one
export function getBuildKitVolumeName(task: { cwd: string; name: string }): string {
  return getVolumeName(join(task.cwd, '.hammerkit', 'buildkit', task.name))
}

// The command of the task: BuildKit's own `buildctl`, without a daemon. Every value of the
// build file is a quoted word of it, never shell to run.
export function getImageBuildCommand(cwd: string, build: WorkImageBuild): string {
  const context = toPosix(relative(cwd, build.context)) || '.'
  const dockerfileDir = toPosix(relative(cwd, dirname(build.dockerfile))) || '.'
  const dockerfileName = posix.basename(toPosix(build.dockerfile))
  const lines: string[] = [
    'set -e',
    // on a dev machine the volume of the task is mounted there already
    `grep -qs ${quote(` ${BUILDKIT_STATE} `)} /proc/mounts || mount -t tmpfs tmpfs ${BUILDKIT_STATE}`,
    'export DOCKER_CONFIG="$(mktemp -d)"',
  ]
  if (build.logins.length > 0) {
    // the password of each, in a docker config.json, which BuildKit reads for the push and the cache
    lines.push(
      'auth() { printf \'"%s":{"auth":"%s"}\' "$1" "$(printf \'%s:%s\' "$2" "$(printf \'%s\' "$3" | tr -d \'\\r\\n\')" | base64 | tr -d \'\\n\')"; }',
      `{ printf '{"auths":{'; ${build.logins
        .map((login) => `auth ${quote(getAuthKey(login.registry))} ${quote(login.user)} "$${login.passwordEnv}"`)
        .join("; printf ','; ")}; printf '}}'; } > "$DOCKER_CONFIG/config.json"`
    )
  }
  lines.push(
    'set --',
    // A task with a `network` reaches the internet through hammerkit's egress proxy. BuildKit
    // pulls and pushes through it with the task's variables, but its RUN steps see neither them
    // nor the task's /etc/hosts: they get the proxy as build args and its address as a host.
    'for name in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy; do',
    '  eval "value=\\${$name:-}"',
    '  if [ -n "$value" ]; then set -- "$@" --opt "build-arg:$name=$value"; fi',
    'done',
    `proxy="$(getent hosts ${EGRESS_PROXY_HOST} | awk '{print $1; exit}' || true)"`,
    `if [ -n "$proxy" ]; then set -- "$@" --opt "add-hosts=${EGRESS_PROXY_HOST}=$proxy"; fi`
  )
  const insecure = build.insecure ? ',registry.insecure=true' : ''
  if (build.platforms.length > 0) {
    // one image for each under one name; BuildKit runs a RUN step of another platform in the
    // QEMU of its image (buildkit-qemu-*), so the machine needs no emulator of its own
    lines.push(`set -- "$@" --opt ${quote(`platform=${build.platforms.join(',')}`)}`)
  }
  if (build.cache) {
    lines.push(
      `set -- "$@" --import-cache ${quote(`type=registry,ref=${build.cache}${insecure}`)} --export-cache ${quote(
        `type=registry,ref=${build.cache},mode=max${insecure}`
      )}`
    )
  }
  if (build.tags.length > 0) {
    const names = build.tags.length === 1 ? `name=${build.tags[0]}` : `"name=${build.tags.join(',')}"`
    lines.push(`set -- "$@" --output ${quote(`type=image,${names},push=${build.push}${insecure}`)}`)
  }
  lines.push(
    // buildctl-daemonless.sh runs $BUILDCTL, $BUILDKITD and $BUILDKITD_FLAGS: BuildKit's own
    `BUILDCTL=buildctl BUILDKITD=buildkitd BUILDKITD_FLAGS= buildctl-daemonless.sh build --progress plain --frontend dockerfile.v0 --local context=${quote(
      context
    )} --local dockerfile=${quote(dockerfileDir)} --opt filename=${quote(
      dockerfileName
    )} "$@" --metadata-file ${METADATA_FILE}`
  )
  if (build.digest) {
    const digestFile = toPosix(relative(cwd, build.digest))
    lines.push(
      `digest="$(grep -o '"containerimage.digest": *"[^"]*"' ${METADATA_FILE} | cut -d '"' -f 4)"`,
      `if [ -z "$digest" ]; then echo 'hammerkit: BuildKit reported no digest of the image' >&2; exit 1; fi`,
      `mkdir -p ${quote(posix.dirname(digestFile))}`,
      `printf '%s@%s\\n' ${quote(getImageName(build.tags[0]))} "$digest" > ${quote(digestFile)}`,
      `echo "${getImageName(build.tags[0])}@$digest"`
    )
  }
  return lines.join('\n')
}

// The name of an image without its tag or digest: ghcr.io/acme/app:1 is ghcr.io/acme/app,
// localhost:5000/app is itself
export function getImageName(image: string): string {
  const withoutDigest = image.split('@')[0]
  const slash = withoutDigest.lastIndexOf('/')
  const colon = withoutDigest.lastIndexOf(':')
  return colon > slash ? withoutDigest.substring(0, colon) : withoutDigest
}

// The key of a registry in a docker config.json: Docker Hub's is its old index URL
function getAuthKey(registry: string): string {
  return ['docker.io', 'index.docker.io', 'registry-1.docker.io'].includes(registry.toLowerCase())
    ? 'https://index.docker.io/v1/'
    : registry
}

function quote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`
}

function toPosix(value: string): string {
  return sep === posix.sep ? value : value.split(sep).join(posix.sep)
}

function isInside(folder: string, path: string): boolean {
  const rel = relative(folder, path)
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
