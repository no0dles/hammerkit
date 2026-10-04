import { join } from 'path'
import { mapGenerate, parseWorkGenerate } from './parse-work-generate'
import { getVolumeName } from './plan-work-volume'
import { WorkEnvironmentVariables } from '../../environment/replace-env-variables'
import { BuildFileTaskSchema } from '../../schema/build-file-task-schema'

const noEnvs: WorkEnvironmentVariables = { variables: {}, replacements: [] }

describe('mapGenerate', () => {
  it('treats a bare string as path with defaults', () => {
    expect(mapGenerate('dist')).toEqual({ path: 'dist', resetOnChange: true, export: false, exportAlways: false })
  })

  it('preserves resetOnChange and export from an object', () => {
    expect(mapGenerate({ path: 'out', resetOnChange: true, export: true } as any)).toEqual({
      path: 'out',
      resetOnChange: true,
      export: true,
      exportAlways: false,
    })
  })

  it('reads export: always as exported, also on failure', () => {
    expect(mapGenerate({ path: 'report', export: 'always' })).toEqual({
      path: 'report',
      resetOnChange: true,
      export: true,
      exportAlways: true,
    })
  })

  it('defaults resetOnChange to true and export to false when omitted', () => {
    expect(mapGenerate({ path: 'out' } as any)).toEqual({
      path: 'out',
      resetOnChange: true,
      export: false,
      exportAlways: false,
    })
  })
})

describe('parseWorkGenerate', () => {
  it('returns [] when the task has no generates', () => {
    expect(parseWorkGenerate('/work', {} as BuildFileTaskSchema, noEnvs)).toEqual([])
  })

  it('joins paths against cwd, templates env vars and marks files with an extension', () => {
    const result = parseWorkGenerate('/work', { generates: ['dist', { path: 'out/$NAME.json' }] } as any, {
      variables: { NAME: 'pkg' },
      replacements: [],
    })
    expect(result[0]).toMatchObject({
      path: join('/work', 'dist'),
      isFile: false,
      resetOnChange: true,
      export: false,
      inherited: null,
    })
    expect(result[0].volumeName).toBe(getVolumeName(join('/work', 'dist')))
    expect(result[1]).toMatchObject({
      path: join('/work', 'out/pkg.json'),
      isFile: true,
    })
  })
})
