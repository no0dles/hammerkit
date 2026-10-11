import { array, boolean, number, object, string, union, z } from 'zod'
import { envsSchema } from './envs-schema'
import { buildFileNeedSchema } from './build-file-need-schema'
import { labelsSchema } from './labels-schema'
import { buildFileServiceContainerHealthcheck } from './build-file-service-container-healthcheck'
import { buildFileSecretSchema } from './build-file-secret-schema'
import { resourcesSchema } from './resources-schema'

export const buildFileContainerServiceSchema = object({
  image: string(),
  description: string().optional(),
  // Optional: a service reached only via `needs`/service-DNS (e.g. postgres:5432
  // from another container) does not need a published host port.
  ports: array(union([string(), number()])).optional(),
  envs: envsSchema.optional(),
  mounts: array(string()).optional(),
  deps: array(string()).optional(),
  src: array(string()).optional(),
  needs: array(buildFileNeedSchema).optional(),
  cmd: string().optional(),
  // Absolute path inside the container. Without it the service runs in the
  // build file's directory, like a task; images whose entrypoint expects their
  // own WORKDIR (relative `./dist/…` paths, `npm start`) need it.
  workdir: string().optional(),
  // Runs `cmd` and the healthcheck as `<shell> -c "<cmd>"` (replacing the
  // image entrypoint for `cmd`), like a task's `shell`. Without it both are
  // split into exec-form arguments.
  shell: string().optional(),
  volumes: array(string()).optional(),
  labels: labelsSchema.optional(),
  continuous: boolean().optional(),
  healthcheck: buildFileServiceContainerHealthcheck.optional(),
  // a task (name or prefix:name, as in deps) that runs once the healthcheck
  // passed; the service counts as ready for dependents only after it succeeded
  init: string().describe('task run once the service is healthy, before dependents start').optional(),
  secrets: array(buildFileSecretSchema).optional(),
  // the service account its provider secrets are read as, unless a secret names one
  account: string().optional(),
  resources: resourcesSchema.optional(),
})
  .strict()
  .describe('container service')

export type BuildFileContainerServiceSchema = z.infer<typeof buildFileContainerServiceSchema>
