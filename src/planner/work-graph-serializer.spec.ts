import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { Environment } from '../executer/environment'
import { serializeWorkGraph } from './work-graph-serializer'

async function graphOf(
  name: string,
  files: { [key: string]: any },
  format: 'mermaid' | 'dot' = 'mermaid',
  scope: { taskName?: string } = {}
) {
  const t = createTestCase(name, files)
  let result!: ReturnType<typeof serializeWorkGraph>
  await t.setup(async (cwd: string, environment: Environment) => {
    const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, scope as any)
    result = cli.graph(format)
  })
  return result
}

describe('work graph serializer (fast)', () => {
  it('emits one node per task and one edge per dependency (SC-001)', async () => {
    const { output, cycle } = await graphOf('graph-deps', {
      '.hammerkit.yaml': {
        tasks: {
          a: { cmds: ['true'] },
          b: { cmds: ['true'], deps: ['a'] },
        },
      },
    })
    expect(cycle).toBeNull()
    expect(output.startsWith('graph TD')).toBe(true)
    // exactly two task nodes
    expect(output.match(/^ {2}t\d+\["/gm)?.length).toBe(2)
    // exactly one deps (solid) edge
    expect(output.match(/-->/g)?.length).toBe(1)
  })

  it('renders a service need as a distinct (dotted) edge type from a deps edge', async () => {
    const { output } = await graphOf('graph-needs', {
      '.hammerkit.yaml': {
        services: { db: { image: 'postgres', ports: [] } },
        tasks: { app: { cmds: ['true'], needs: ['db'] } },
      },
    })
    // service node uses the stadium shape, distinct from a task rectangle
    expect(output).toMatch(/^ {2}s\d+\(\["db"\]\)/m)
    // the need is a dotted edge, not a solid deps arrow
    expect(output).toMatch(/-\.->/)
    expect(output).not.toMatch(/[^.]-->/)
  })

  it('emits valid graphviz dot with --format dot', async () => {
    const { output } = await graphOf(
      'graph-dot',
      { '.hammerkit.yaml': { tasks: { a: { cmds: ['true'] }, b: { cmds: ['true'], deps: ['a'] } } } },
      'dot'
    )
    expect(output.startsWith('digraph hammerkit {')).toBe(true)
    expect(output.trimEnd().endsWith('}')).toBe(true)
    expect(output).toMatch(/shape=box/)
    expect(output).toMatch(/"t\d+" -> "t\d+";/)
  })

  it('scopes to a single task transitive subgraph (SC-004)', async () => {
    const { output } = await graphOf(
      'graph-scope',
      {
        '.hammerkit.yaml': {
          tasks: {
            base: { cmds: ['true'] },
            mid: { cmds: ['true'], deps: ['base'] },
            unrelated: { cmds: ['true'] },
          },
        },
      },
      'mermaid',
      { taskName: 'mid' }
    )
    expect(output).toContain('"mid"')
    expect(output).toContain('"base"')
    expect(output).not.toContain('"unrelated"')
  })

  it('renders an isolated task as a lone node with no edges', async () => {
    const { output } = await graphOf('graph-isolated', {
      '.hammerkit.yaml': { tasks: { solo: { cmds: ['true'] } } },
    })
    expect(output.match(/^ {2}t\d+\["/gm)?.length).toBe(1)
    expect(output).not.toMatch(/-->/)
  })

  it('still renders and reports a cycle instead of crashing', async () => {
    const { output, cycle } = await graphOf('graph-cycle', {
      '.hammerkit.yaml': {
        tasks: {
          a: { cmds: ['true'], deps: ['b'] },
          b: { cmds: ['true'], deps: ['a'] },
        },
      },
    })
    expect(cycle).not.toBeNull()
    expect(output).toContain('%% cycle detected:')
    // both nodes still rendered
    expect(output.match(/^ {2}t\d+\["/gm)?.length).toBe(2)
  })
})
