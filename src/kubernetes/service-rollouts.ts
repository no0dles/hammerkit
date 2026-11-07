import { V1Deployment } from '@kubernetes/client-node'
import { KubernetesInstance } from './kubernetes-instance'
import { replace, statusCodeOf } from './apply'
import { getErrorMessage } from '../log'

interface Rolled {
  namespace: string
  name: string
  // the Deployment as it was before, none for one that was made
  previous?: V1Deployment
}

/**
 * The Deployments an execution of a service run replaced or made (rollOut). A move whose
 * services do not all get up leaves the run where it was: the execution puts every one of
 * them back as it found it and removes the ones it made, so no service serves the commit the
 * run did not get to, and nothing of it takes the quota of the namespace.
 */
export class ServiceRollouts {
  private readonly rolled = new Map<string, Rolled>()

  // before the Deployment is replaced or made; the first time counts
  add(namespace: string, name: string, previous: V1Deployment | undefined): void {
    const key = `${namespace}/${name}`
    if (!this.rolled.has(key)) {
      this.rolled.set(key, { namespace, name, ...(previous?.spec ? { previous } : {}) })
    }
  }

  get size(): number {
    return this.rolled.size
  }

  async undo(instance: KubernetesInstance, say: (text: string) => void): Promise<void> {
    const rolled = [...this.rolled.values()]
    this.rolled.clear()
    for (const { namespace, name, previous } of rolled) {
      try {
        if (previous?.spec) {
          say(`putting ${name} back as it was`)
          await replace(instance, {
            kind: 'Deployment',
            apiVersion: 'apps/v1',
            metadata: {
              namespace,
              name,
              labels: previous.metadata?.labels,
              annotations: previous.metadata?.annotations,
            },
            spec: previous.spec,
          })
        } else {
          say(`removing ${name}, which it made`)
          await instance.appsApi
            .deleteNamespacedDeployment({ name, namespace, propagationPolicy: 'Background' })
            .catch((e) => {
              if (statusCodeOf(e) !== 404) {
                throw e
              }
            })
        }
      } catch (e) {
        say(`${name} could not be put back: ${getErrorMessage(e)}`)
      }
    }
  }
}

// the rollouts of this process: a worker executes one run
export const serviceRollouts = new ServiceRollouts()
