import 'jest-extended'
import { createTestCase, TestCase } from '../test-case'

describe('validate', () => {
  async function validateTask(testCase: TestCase, name: string, expectedErrors: string[]) {
    await testCase.cli({ taskName: name }, async (cli) => {
      let i = 0
      for await (const message of cli.validate()) {
        expect(message.message).toEqual(expectedErrors[i++])
      }
      expect(i).toEqual(expectedErrors.length)
    })
  }

  it('should validate local task', async () => {
    const testCase = createTestCase('valid_local_task', {
      '.hammerkit.yaml': {
        tasks: {
          valid_local_task: {
            description: 'build code',
            cmds: ['make'],
          },
        },
      },
    })
    await validateTask(testCase, 'valid_local_task', [])
  })

  it('should validate container task', async () => {
    const testCase = createTestCase('valid_container_task', {
      '.hammerkit.yaml': {
        tasks: {
          valid_container_task: {
            image: 'alpine',
            description: 'build code',
            cmds: ['make'],
            mounts: ['/.kube:/.kube'],
          },
        },
      },
    })
    await validateTask(testCase, 'valid_container_task', [])
  })

  it('should warn about tasks without description', async () => {
    const testCase = createTestCase('missing_doc', {
      '.hammerkit.yaml': {
        tasks: {
          missing_doc: {
            image: 'alpine',
            cmds: ['make'],
            mounts: ['/.kube:/.kube'],
          },
        },
      },
    })
    await validateTask(testCase, 'missing_doc', ['missing description'])
  })

  it('should detect empty tasks without cmds', async () => {
    const testCase = createTestCase('missing_cmd', {
      '.hammerkit.yaml': {
        tasks: {
          missing_cmd: {
            image: 'alpine',
            description: 'build code',
            mounts: ['/.kube:/.kube'],
          },
        },
      },
    })
    await validateTask(testCase, 'missing_cmd', ['task is empty'])
  })

  it('should allow only deps without cmds', async () => {
    const testCase = createTestCase('dep_only', {
      '.hammerkit.yaml': {
        tasks: {
          build: {
            cmds: ['make'],
            description: 'build code',
          },
          dep_only: {
            image: 'alpine',
            description: 'deps',
            deps: ['build'],
          },
        },
      },
    })
    await validateTask(testCase, 'dep_only', [])
  })

  it('should detect loop in dep', async () => {
    const testCase = createTestCase('loop_with_dep', {
      '.hammerkit.yaml': {
        tasks: {
          loop_with_dep: {
            image: 'alpine',
            description: 'build code',
            cmds: ['make'],
            deps: ['loop_with_dep'],
          },
        },
      },
    })
    await validateTask(testCase, 'loop_with_dep', ['task cycle detected loop_with_dep -> loop_with_dep'])
  })

  it('should detect loop in refs', async () => {
    const testCase = createTestCase('loop_with_refs', {
      '.hammerkit.yaml': {
        tasks: {
          loop_with_refs: {
            image: 'alpine',
            description: 'build code',
            cmds: ['make'],
            deps: ['ref:loop_with_refs'],
          },
        },
        references: { ref: '.hammerkit2.yaml' },
      },
      '.hammerkit2.yaml': {
        tasks: {
          loop_with_refs: {
            deps: ['ref:loop_with_refs'],
            image: 'alpine',
            description: 'build code',
            cmds: ['make 2'],
          },
        },
        references: { ref: '.hammerkit.yaml' },
      },
    })
    await validateTask(testCase, 'loop_with_refs', [
      'task cycle detected loop_with_refs -> ref:loop_with_refs -> loop_with_refs',
    ])
  })

  it('should detect loop over multiple tasks', async () => {
    const testCase = createTestCase('loop_with_multiple_tasks', {
      '.hammerkit.yaml': {
        tasks: {
          first: {
            image: 'alpine',
            description: 'build code',
            cmds: ['make 1'],
            deps: ['second'],
          },
          second: {
            image: 'alpine',
            description: 'build code',
            cmds: ['make 2'],
            deps: ['third'],
          },
          third: {
            image: 'alpine',
            description: 'build code',
            cmds: ['make 3'],
            deps: ['first'],
          },
        },
      },
    })
    await validateTask(testCase, 'first', ['task cycle detected first -> second -> third -> first'])
  })
})
