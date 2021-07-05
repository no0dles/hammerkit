import 'jest-extended'
import { validate } from '../src/planner/validate'
import { getTestSuite} from './run-arg';

describe('validate', () => {
  const suite = getTestSuite('validate', ['build.yaml', 'build-loop.yaml'])
  async function validateTask(name: string, expectedErrors: string[]) {
    const {buildFile, context} = await suite.setup()

    let i = 0;
    for await (const message of validate(buildFile, context, name)) {
      expect(expectedErrors[i++]).toEqual(message.message)
    }
    expect(i).toEqual(expectedErrors.length)
  }

  it('should validate regular task', async () => {
    await validateTask('regular_task', [])
  })

  it('should validate regular docker task', async () => {
    await validateTask('regular_docker_task', [])
  })

  it('should validate task without description', async () => {
    await validateTask('missing_desc', ['missing description'])
  })

  it('should detect empty tasks', async () => {
    await validateTask('empty', ['task is empty'])
  })

  it('should allow only deps', async () => {
    await validateTask('only_deps', [])
  })

  it('should detect loop in dep', async () => {
    await validateTask('loop_with_dep', ['task cycle detected loop_with_dep -> loop_with_dep'])
  })

  it('should detect loop in refs', async () => {
    await validateTask('loop_with_refs', ['task cycle detected loop_with_refs -> loop_with_refs'])
  })

  it('should detect loop over multiple tasks', async () => {
    await validateTask('loop_with_multiple_tasks', [
      'task cycle detected loop_with_multiple_tasks -> loop_with_multiple_tasks_2 -> loop_with_multiple_tasks',
    ])
  })
})
