import { array, boolean, object, string, union, z } from 'zod'
import { buildFileBaseTaskSchema } from './build-file-base-task-schema'
import { sizeSchema } from './size-schema'

// A registry host, with a port where it has one: europe-west4-docker.pkg.dev, ghcr.io, localhost:5000
const REGISTRY = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$/i

// The name of an image with its tag or digest, as `docker build --tag` takes it. A comma, a
// quote or a space would end it in BuildKit's `--output`, so none of them is in one. `$NAME`
// and `${NAME}` take the value of a variable, and the name is checked again with it.
const IMAGE = /^[a-z0-9$][a-z0-9._/:@${}-]*$/i

// the password of a registry login, read like a secret of the task, never written in the build file
const registryPasswordSchema = object({
  from: string().regex(/^[A-Za-z][A-Za-z0-9_-]*:.+$/, 'from must be env:NAME, file:path or <provider>:<ref>'),
  account: string().optional(),
})
  .strict()
  .describe('the password, a secret from env:NAME, file:path or <provider>:<ref>')

export const buildFileRegistryLoginSchema = object({
  registry: string().regex(REGISTRY, 'registry must be a host, with a port where it has one (ghcr.io, localhost:5000)'),
  // a user name of basic auth holds no colon; a quote or a backslash would end it in the JSON
  user: string().regex(/^[^:"\\\s]+$/, 'user must not hold a colon, a quote, a backslash or a space'),
  password: registryPasswordSchema,
})
  .strict()
  .describe('a sign-in to a registry, for the push and the cache')

export const buildFileImageBuildSchema = object({
  // the folder sent to the build, relative to the task's directory
  context: string().optional().describe('the build context, `.` when left out'),
  // the Dockerfile, relative to the task's directory
  dockerfile: string().optional().describe('the Dockerfile, Dockerfile in the context when left out'),
  tags: union([string().regex(IMAGE, 'a tag must be an image name'), array(string().regex(IMAGE)).min(1)])
    .optional()
    .describe('the names of the image, with their tags, as docker build --tag'),
  push: boolean().optional().describe('push the image to its registry, as docker build --push'),
  // an image the layers are read from before the build and written to after it
  cache: string()
    .regex(IMAGE, 'cache must be an image name, such as ghcr.io/acme/app:buildcache')
    .optional()
    .describe('an image in a registry the build reads its layers from and writes them to'),
  // a file the task writes <name>@<digest> of the image to, which another task deploys
  digest: string().optional().describe('a file the task writes <image>@<digest> to'),
  login: array(buildFileRegistryLoginSchema).optional(),
  // the registries of the tags and the cache speak plain HTTP, as a registry:2 on a network of
  // your own does (docker's --insecure-registry)
  insecure: boolean().optional().describe('reach the registries over plain HTTP'),
})
  .strict()
  .refine((build) => !build.push || build.tags !== undefined, {
    message: 'push needs tags, the names of the image to push',
  })
  .refine((build) => build.digest === undefined || build.tags !== undefined, {
    message: 'digest needs tags, the name the digest is written with',
  })
  .describe('builds a Dockerfile with BuildKit, as docker build does')

// A task that builds an image: hammerkit runs BuildKit for it, so it names no image, commands or
// shell of its own, and doesn't extend another task or take arguments.
export const buildFileImageBuildTaskSchema = buildFileBaseTaskSchema
  .omit({ extend: true, reset: true, cmds: true, shell: true, args: true })
  .extend({
    build: buildFileImageBuildSchema,
    volumeSize: sizeSchema.describe('size of its claim on Kubernetes, e.g. 10Gi').optional(),
  })
  .strict()
  .describe('task that builds an image')

export type BuildFileImageBuildSchema = z.infer<typeof buildFileImageBuildSchema>
export type BuildFileImageBuildTaskSchema = z.infer<typeof buildFileImageBuildTaskSchema>
