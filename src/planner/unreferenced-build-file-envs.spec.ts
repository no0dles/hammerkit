import { getUnreferencedBuildFileEnvs } from './unreferenced-build-file-envs'
import { WorkTask } from './work-task'

function task(name: string, schema: { [key: string]: any }, namePrefix = ''): WorkTask {
  const localName = namePrefix ? name.substring(namePrefix.length + 1) : name
  return {
    name,
    scope: {
      namePrefix,
      schema: {
        envs: { NODE_IMAGE: 'node:24', API_URL: 'http://api', NODE_ENV: 'test' },
        tasks: { [localName]: schema },
      },
    },
  } as unknown as WorkTask
}

describe('getUnreferencedBuildFileEnvs', () => {
  it('lists build-file envs the task never mentions', () => {
    expect(getUnreferencedBuildFileEnvs(task('lint', { image: '$NODE_IMAGE', cmds: ['eslint .'] }))).toEqual([
      'API_URL',
      'NODE_ENV',
    ])
  })

  it('counts $NAME and ${NAME} in any field, case-insensitively', () => {
    const e2e = task('e2e', { image: '$node_image', cmds: ['curl ${API_URL}', 'echo $NODE_ENV/x'] })
    expect(getUnreferencedBuildFileEnvs(e2e)).toEqual([])
  })

  it('does not count a longer name with the same prefix', () => {
    expect(getUnreferencedBuildFileEnvs(task('t', { cmds: ['echo $NODE_IMAGES $API_URL_V2 $NODE_ENV'] }))).toEqual([
      'NODE_IMAGE',
      'API_URL',
    ])
  })

  it('skips envs the task defines itself', () => {
    const own = task('t', { envs: { API_URL: 'http://other', NODE_ENV: 'prod' }, image: '$NODE_IMAGE', cmds: ['x'] })
    expect(getUnreferencedBuildFileEnvs(own)).toEqual([])
  })

  it('finds the task in a prefixed scope', () => {
    expect(getUnreferencedBuildFileEnvs(task('lib:build', { cmds: ['echo $NODE_ENV $API_URL'] }, 'lib'))).toEqual([
      'NODE_IMAGE',
    ])
  })

  it('stays quiet for tasks that extend another, or that it cannot find', () => {
    expect(getUnreferencedBuildFileEnvs(task('t', { extend: 'base', cmds: ['x'] }))).toEqual([])
    expect(getUnreferencedBuildFileEnvs(task('ci', { deps: ['lint', 'test'] }))).toEqual([])
    const unknown = { ...task('t', { cmds: ['x'] }), name: 't[node=20]' } as WorkTask
    expect(getUnreferencedBuildFileEnvs(unknown)).toEqual([])
  })
})
