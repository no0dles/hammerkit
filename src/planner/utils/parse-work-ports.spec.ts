import { parseWorkPorts } from './parse-work-ports'
import { WorkEnvironmentVariables } from '../../environment/replace-env-variables'
import { BuildFileServiceSchema } from '../../schema/build-file-service-schema'

const noEnvs: WorkEnvironmentVariables = { variables: {}, replacements: [] }

describe('parse-work-ports', () => {
  it('returns an empty list when the service declares no ports', () => {
    const schema = { image: 'postgres:12-alpine' } as unknown as BuildFileServiceSchema
    expect(parseWorkPorts(schema, noEnvs)).toEqual([])
  })

  it('parses numeric and string ports', () => {
    const schema = { image: 'node', ports: [5432, '8080:80'] } as unknown as BuildFileServiceSchema
    expect(parseWorkPorts(schema, noEnvs)).toEqual([
      { hostPort: 5432, containerPort: 5432 },
      { hostPort: 8080, containerPort: 80 },
    ])
  })

  it('templates env vars in port values', () => {
    const schema = { image: 'node', ports: ['$PORT:80'] } as unknown as BuildFileServiceSchema
    expect(parseWorkPorts(schema, { variables: { PORT: '9090' }, replacements: [] })).toEqual([
      { hostPort: 9090, containerPort: 80 },
    ])
  })
})
