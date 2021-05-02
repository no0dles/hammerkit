import { loadExampleBuildFile } from './run-arg'
import {validate} from '../src/rewrite/8-validate';

describe('validate', () => {
  const buildFile = loadExampleBuildFile('validate')

  function validateTask(name: string, expectedErrors: string[]) {
    const result = Array.from(validate(buildFile, name))
    expect(result.map(r => r.message)).toIncludeSameMembers(expectedErrors)
  }

  it('should validate regular task', async () => {
    validateTask('regular_task', [])
  })

  it('should validate regular docker task', async () => {
    validateTask('regular_docker_task', [])
  })

  it('should validate task without description', async () => {
    validateTask('missing_desc', ['missing description'])
  })

  it('should detect empty tasks', async () => {
    validateTask('empty', ['task is empty'])
  })

  it('should allow only deps', async () => {
    validateTask('only_deps', [])
  })

  it('should detect loop in dep', async () => {
    validateTask('loop_with_dep', ['task cycle detected loop_with_dep -> loop_with_dep'])
  })

  it('should detect loop in refs', async () => {
    validateTask('loop_with_refs', ['task cycle detected loop_with_refs -> loop_with_refs'])
  })

  it('should detect loop over multiple tasks', async () => {
    validateTask('loop_with_multiple_tasks', ['task cycle detected loop_with_multiple_tasks -> loop_with_multiple_tasks_2 -> loop_with_multiple_tasks'])
  })
})
