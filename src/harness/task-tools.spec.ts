import { z } from 'zod'
import { createTaskTools, describeTasks, taskToolArgs, taskToolSchema } from './task-tools'

describe('task tools', () => {
  it('lists the tasks for the model: what each is for and whether it takes arguments', () => {
    expect(
      describeTasks(
        [
          { name: 'test', description: 'Run the unit tests,\n  with coverage', command: 'npm test', args: null },
          { name: 'lint', command: 'npx eslint .', args: 'lint takes no arguments (args: false)' },
          { name: 'sh', command: 'sh -c', args: null },
          { name: 'all', command: null },
          // a server that does not say about arguments
          { name: 'build', command: `node build.js ${'x'.repeat(200)}` },
        ],
        'sh'
      )
    ).toBe(
      [
        'The tasks of the published build file:',
        '- test: Run the unit tests, with coverage (takes args)',
        '- lint: runs `npx eslint .` (takes no args)',
        '- all (takes no args)',
        `- build: runs \`node build.js ${'x'.repeat(86)}…\``,
      ].join('\n')
    )
    // without a shell tool its task is one to run
    expect(describeTasks([{ name: 'sh', command: 'sh -c', args: null }])).toContain('- sh: runs `sh -c` (takes args)')
    expect(describeTasks([])).toBe('The published build file has no tasks to run.')
    expect(describeTasks({ error: 'no answer within 15 s' })).toBe(
      'The tasks of the build file could not be listed (no answer within 15 s); name one as the build file does.'
    )
    const many = Array.from({ length: 45 }, (_, index) => ({ name: `t${index}` }))
    expect(describeTasks(many).split('\n').slice(-2)).toEqual(['- t39', '- and 5 more'])
  })

  it('puts the list into the description of run_task, and nothing without one', () => {
    const [runTask, runLogs] = createTaskTools([{ name: 'test', description: 'Run the tests' }])
    expect(runTask.description).toMatch(/args are appended to its last command[^]*\n\n.*\n- test: Run the tests$/)
    expect(createTaskTools()[0].description).not.toContain('The tasks')
    expect(runLogs.name).toBe('run_logs')
  })

  it('declares the same parameters as a JSON schema and with the zod of opencode 1', () => {
    const [runTask, runLogs] = createTaskTools()
    expect(taskToolSchema(runTask)).toEqual({
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The name of the task' },
        args: { type: 'array', items: { type: 'string' }, description: 'Arguments for its last command' },
      },
      required: ['task'],
    })
    expect(taskToolSchema(runLogs).properties.tail).toEqual({
      type: 'integer',
      description: 'The last lines, or with grep the last matches',
      minimum: 1,
      maximum: 1000,
    })
    const logs = z.object(taskToolArgs(runLogs, z) as z.ZodRawShape)
    expect(logs.safeParse({ run: 'run_1', tail: 20, ignore_case: true }).success).toBe(true)
    expect(logs.safeParse({ tail: 20 }).success).toBe(false)
    expect(logs.safeParse({ run: 'run_1', tail: 2000 }).success).toBe(false)
    expect(logs.safeParse({ run: 'run_1', context: 1.5 }).success).toBe(false)
    const task = z.object(taskToolArgs(runTask, z) as z.ZodRawShape)
    expect(task.safeParse({ task: 'test', args: ['src/a.spec.ts'] }).success).toBe(true)
    expect(task.safeParse({ task: 'test', args: 'src/a.spec.ts' }).success).toBe(false)
  })
})
