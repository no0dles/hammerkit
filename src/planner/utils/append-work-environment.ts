import { ReferenceEnvironment } from '../../schema/reference-parser'
import { WorkEnvironment } from '../work-environment'

export function appendWorkEnvironment(referenced: ReferenceEnvironment): WorkEnvironment {
  if ('docker' in referenced.schema) {
    return {
      type: 'docker',
      host: referenced.schema.docker.host,
    }
  } else {
    return {
      type: 'kubernetes',
      context: referenced.schema.kubernetes.context,
      ingresses: referenced.schema.kubernetes.ingresses || [],
      namespace: referenced.schema.kubernetes.namespace ?? 'default',
    }
  }
}
