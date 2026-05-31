import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { environmentMock } from '../../executer/environment-mock'
import { createParseContext } from '../../schema/schema-parser'
import { parseReferences } from '../../schema/reference-parser'
import { getWorkContext } from '../../schema/work-scope-parser'
import { WorkScope } from '../../executer/work-scope'
import { KubernetesWorkService } from '../work-service'

describe('appendWorkService (kubernetes service env inheritance)', () => {
  let scratch: string

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'hammerkit-k8s-svc-'))
  })
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  async function parse(content: string, environmentName: string | null) {
    const env = environmentMock(scratch)
    const file = join(scratch, '.hammerkit.yaml')
    writeFileSync(file, content)
    const { ctx, scope } = await createParseContext(file, env)
    const referenced = await parseReferences(ctx, scope, env)
    const workScope: WorkScope = { environmentName, filterLabels: {}, excludeLabels: {} }
    return { referenced, env, workScope }
  }

  const envBlock = `environments:
  prod:
    kubernetes:
      context: gke_prod
      kubeconfig: ./prod-kube.yaml
      namespace: databases
`

  function postgres(extra = ''): string {
    return `services:
  postgres:
${extra}    selector:
      type: deployment
      name: postgres
    ports:
      - 5432:5432
`
  }

  it('inherits context, kubeconfig and namespace from the selected environment', async () => {
    const { referenced, env, workScope } = await parse(envBlock + postgres(), 'prod')

    const work = getWorkContext(referenced, workScope, env)
    const service = work.services['postgres'].data as KubernetesWorkService

    expect(service.type).toEqual('kubernetes-service')
    expect(service.context).toEqual('gke_prod')
    expect(service.kubeconfig).toEqual('./prod-kube.yaml')
    expect(service.namespace).toEqual('databases')
  })

  it('lets a service override the namespace while inheriting the context', async () => {
    const { referenced, env, workScope } = await parse(envBlock + postgres('    namespace: orders\n'), 'prod')

    const work = getWorkContext(referenced, workScope, env)
    const service = work.services['postgres'].data as KubernetesWorkService

    expect(service.namespace).toEqual('orders')
    expect(service.context).toEqual('gke_prod')
  })

  it('keeps an explicit service context over the environment (backward compatible)', async () => {
    const { referenced, env, workScope } = await parse(envBlock + postgres('    context: own-ctx\n'), 'prod')

    const work = getWorkContext(referenced, workScope, env)
    const service = work.services['postgres'].data as KubernetesWorkService

    expect(service.context).toEqual('own-ctx')
  })

  it('throws a descriptive error when no context can be resolved', async () => {
    const { referenced, env, workScope } = await parse(postgres(), null)

    expect(() => getWorkContext(referenced, workScope, env)).toThrow(/postgres has no context/)
  })
})
