import { parseWorkMounts } from './parse-work-mounts'
import { WorkEnvironmentVariables } from '../../environment/replace-env-variables'

const noEnvs: WorkEnvironmentVariables = { variables: {}, replacements: [] }

describe('parseWorkMounts', () => {
  it('returns [] when no mounts are declared', () => {
    expect(parseWorkMounts('/work', {} as any, noEnvs)).toEqual([])
  })

  it('templates env vars and parses each mount against the cwd', () => {
    const result = parseWorkMounts('/work', { mounts: ['$PWD/.npm:/.npm', 'config:/etc/config'] } as any, {
      variables: { PWD: '/home/x' },
      replacements: [],
    })
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ containerPath: '/.npm' })
    expect(result[1]).toMatchObject({ containerPath: '/etc/config' })
  })
})
