import { WorkTree } from './work-tree'
import { iterateWorkTasks, iterateWorkServices } from './utils/plan-work-tasks'
import { hasDependencyCycle } from './validate'

export type GraphFormat = 'mermaid' | 'dot'

export interface WorkGraphSerialization {
  output: string
  // The names along a detected dependency cycle, or null. The graph still
  // renders; the cycle is reported as a comment and surfaced to the caller.
  cycle: string[] | null
}

interface GraphNode {
  id: string
  name: string
  kind: 'task' | 'service'
}

interface GraphEdge {
  from: string
  to: string
  kind: 'deps' | 'needs'
}

function buildGraph(workTree: WorkTree): { nodes: GraphNode[]; edges: GraphEdge[]; cycle: string[] | null } {
  const taskItems = Array.from(iterateWorkTasks(workTree)).sort((a, b) => a.name.localeCompare(b.name))
  const serviceItems = Array.from(iterateWorkServices(workTree)).sort((a, b) => a.name.localeCompare(b.name))

  const nodes: GraphNode[] = []
  const taskNodeId = new Map<string, string>()
  const serviceNodeId = new Map<string, string>()

  taskItems.forEach((task, index) => {
    const id = `t${index}`
    taskNodeId.set(task.name, id)
    nodes.push({ id, name: task.name, kind: 'task' })
  })
  serviceItems.forEach((service, index) => {
    const id = `s${index}`
    serviceNodeId.set(service.name, id)
    nodes.push({ id, name: service.name, kind: 'service' })
  })

  const edges: GraphEdge[] = []
  for (const task of taskItems) {
    const from = taskNodeId.get(task.name)
    if (!from) {
      continue
    }
    for (const dep of task.deps) {
      const to = taskNodeId.get(dep.name)
      if (to) {
        edges.push({ from, to, kind: 'deps' })
      }
    }
    for (const need of task.needs) {
      const to = serviceNodeId.get(need.service.name)
      if (to) {
        edges.push({ from, to, kind: 'needs' })
      }
    }
  }
  edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind))

  let cycle: string[] | null = null
  for (const task of taskItems) {
    const path = hasDependencyCycle(task, [])
    if (path && path.length > 0) {
      cycle = path.map((n) => n.name)
      break
    }
  }

  return { nodes, edges, cycle }
}

function mermaidLabel(name: string): string {
  return name.replace(/"/g, "'")
}

function renderMermaid(nodes: GraphNode[], edges: GraphEdge[], cycle: string[] | null): string {
  const lines: string[] = ['graph TD']
  for (const node of nodes) {
    // tasks are rectangles, services are stadium-shaped, so the two are visually distinct
    lines.push(
      node.kind === 'task'
        ? `  ${node.id}["${mermaidLabel(node.name)}"]`
        : `  ${node.id}(["${mermaidLabel(node.name)}"])`
    )
  }
  for (const edge of edges) {
    // deps are solid arrows, needs are dotted — distinct edge types
    lines.push(edge.kind === 'deps' ? `  ${edge.from} --> ${edge.to}` : `  ${edge.from} -.-> ${edge.to}`)
  }
  if (cycle) {
    lines.push(`  %% cycle detected: ${cycle.join(' -> ')}`)
  }
  return lines.join('\n')
}

function dotId(id: string): string {
  return `"${id}"`
}

function dotLabel(name: string): string {
  return name.replace(/"/g, '\\"')
}

function renderDot(nodes: GraphNode[], edges: GraphEdge[], cycle: string[] | null): string {
  const lines: string[] = ['digraph hammerkit {']
  if (cycle) {
    lines.push(`  // cycle detected: ${cycle.join(' -> ')}`)
  }
  for (const node of nodes) {
    const shape = node.kind === 'task' ? 'box' : 'ellipse'
    lines.push(`  ${dotId(node.id)} [label="${dotLabel(node.name)}" shape=${shape}];`)
  }
  for (const edge of edges) {
    const style = edge.kind === 'needs' ? ' [style=dotted]' : ''
    lines.push(`  ${dotId(edge.from)} -> ${dotId(edge.to)}${style};`)
  }
  lines.push('}')
  return lines.join('\n')
}

// Serialize the planner's already-built work graph (tasks, services, deps and
// needs edges) into a renderable format. A cyclic graph still renders and marks
// the cycle rather than crashing.
export function serializeWorkGraph(workTree: WorkTree, format: GraphFormat): WorkGraphSerialization {
  const { nodes, edges, cycle } = buildGraph(workTree)
  const output = format === 'dot' ? renderDot(nodes, edges, cycle) : renderMermaid(nodes, edges, cycle)
  return { output, cycle }
}
