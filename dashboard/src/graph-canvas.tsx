import { useEffect, useMemo, useRef, useState } from 'react'
import { Handle, MarkerType, Position, ReactFlow, Controls, type Edge, type Node, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import dagre from '@dagrejs/dagre'
import type { TaskPlan } from './api'
import type { NodeState, TaskGraphProps } from './graph'
import { printable } from './format'
import { StateMark } from './ui'

// The graph of TaskGraph (graph.tsx), drawn by React Flow and laid out by dagre: a box per task
// and service, an arrow from what a task depends on to it, dashed from a service it needs.

const NODE_WIDTH = 184
const NODE_HEIGHT = 52
// the smallest a graph is drawn at first, where its names still read
const MIN_ZOOM = 0.6

interface TaskNodeData extends Record<string, unknown> {
  name: string
  entry: TaskPlan | undefined
  state?: NodeState
  selected: boolean
  // not related to the selected task: drawn faint
  faint: boolean
}

type TaskNode = Node<TaskNodeData, 'task'>

const STATE_BORDER: Record<string, string> = {
  succeeded: 'border-emerald-500 dark:border-emerald-400',
  cached: 'border-emerald-300 dark:border-emerald-700',
  failed: 'border-red-500 dark:border-red-400',
  running: 'border-sky-500 dark:border-sky-400',
  starting: 'border-sky-300 dark:border-sky-700',
  ready: 'border-sky-500 dark:border-sky-400',
}

// what a box says below its name without a run: what runs it
function describe(entry: TaskPlan | undefined): string {
  if (!entry) {
    return ''
  }
  if (entry.runtime === 'none') {
    return entry.kind === 'service' ? 'service' : 'groups its dependencies'
  }
  if (entry.image) {
    return entry.kind === 'service' ? `service · ${entry.image}` : entry.image
  }
  return entry.kind === 'service' ? 'service' : `${entry.runtime}, ${entry.cmds.length} cmds`
}

function TaskBox({ data }: NodeProps<TaskNode>) {
  const { name, entry, state, selected, faint } = data
  const service = entry?.kind === 'service'
  const aggregate = entry?.runtime === 'none' && !service
  const border = state ? STATE_BORDER[state.state] ?? 'border-stone-300 dark:border-stone-600' : ''
  const sub = state ? [state.state, state.note].filter(Boolean).join(' · ') : describe(entry)
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} className="invisible" />
      <button
        // the click reaches the graph's onNodeClick, Enter and Space as one too
        type="button"
        aria-pressed={selected}
        title={`${name}${sub ? `: ${sub}` : ''}`}
        className={`flex h-[52px] w-[184px] cursor-pointer items-center gap-2 border-2 bg-white px-2.5 text-left transition-opacity dark:bg-stone-900 ${
          service ? 'rounded-3xl' : 'rounded-md'
        } ${aggregate && !state ? 'border-dashed' : ''} ${
          border || (service ? 'border-violet-400 dark:border-violet-500' : 'border-stone-300 dark:border-stone-600')
        } ${selected ? 'ring-2 ring-emerald-500 ring-offset-2 ring-offset-white dark:ring-offset-stone-950' : ''} ${
          faint ? 'opacity-35' : ''
        } hover:bg-stone-50 focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none dark:hover:bg-stone-800`}
      >
        {state ? <StateMark state={state.state} /> : null}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-xs font-medium text-stone-900 dark:text-stone-100">
            {printable(name)}
          </span>
          <span className="block truncate text-[0.7rem] text-stone-500 dark:text-stone-400">{printable(sub)}</span>
        </span>
        {entry?.flags.length ? (
          <span
            role="img"
            aria-label={`look at: ${entry.flags.join(', ')}`}
            className="h-2 w-2 shrink-0 rounded-full bg-amber-500"
          />
        ) : null}
      </button>
      <Handle type="source" position={Position.Right} isConnectable={false} className="invisible" />
    </>
  )
}

const nodeTypes = { task: TaskBox }

// those a task depends on and needs, and those that depend on it or need it, all the way
function related(plan: Record<string, TaskPlan>, name: string): Set<string> {
  const seen = new Set([name])
  const walk = (from: string, next: (name: string) => string[]) => {
    for (const other of next(from)) {
      if (!seen.has(other)) {
        seen.add(other)
        walk(other, next)
      }
    }
  }
  const up = (each: string) => [...(plan[each]?.deps ?? []), ...(plan[each]?.needs ?? [])]
  const down = (each: string) =>
    Object.entries(plan)
      .filter(([, entry]) => entry.deps.includes(each) || entry.needs.includes(each))
      .map(([other]) => other)
  walk(name, up)
  const upstream = new Set(seen)
  seen.clear()
  seen.add(name)
  walk(name, down)
  return new Set([...upstream, ...seen])
}

// where each box goes: dagre lays the graph out in ranks from left to right
function layout(plan: Record<string, TaskPlan>, names: string[]) {
  const graph = new dagre.graphlib.Graph()
  graph.setGraph({ rankdir: 'LR', nodesep: 14, ranksep: 40, marginx: 8, marginy: 8 })
  graph.setDefaultEdgeLabel(() => ({}))
  const shown = new Set(names)
  for (const name of names) {
    graph.setNode(name, { width: NODE_WIDTH, height: NODE_HEIGHT })
  }
  const edges: { from: string; to: string; need: boolean }[] = []
  for (const name of names) {
    for (const dep of plan[name]?.deps ?? []) {
      if (shown.has(dep)) {
        edges.push({ from: dep, to: name, need: false })
      }
    }
    for (const need of plan[name]?.needs ?? []) {
      if (shown.has(need)) {
        edges.push({ from: need, to: name, need: true })
      }
    }
  }
  for (const edge of edges) {
    graph.setEdge(edge.from, edge.to)
  }
  dagre.layout(graph)
  const positions = new Map(
    names.map((name) => {
      const node = graph.node(name)
      return [name, { x: node.x - NODE_WIDTH / 2, y: node.y - NODE_HEIGHT / 2 }]
    })
  )
  const { width = NODE_WIDTH, height = NODE_HEIGHT } = graph.graph()
  return { positions, edges, width, height }
}

// loaded apart (graph.tsx), the pages without a graph do without the library
export default function TaskGraphCanvas({
  plan,
  names = Object.keys(plan),
  states,
  selected,
  onSelect,
}: TaskGraphProps) {
  const key = names.join('\n')
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the layout changes with the names only
  const laid = useMemo(() => layout(plan, names), [plan, key])
  const near = useMemo(() => (selected ? related(plan, selected) : null), [plan, selected])
  const nodes: TaskNode[] = names.map((name) => ({
    id: name,
    type: 'task',
    position: laid.positions.get(name) ?? { x: 0, y: 0 },
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    draggable: false,
    selectable: false,
    data: {
      name,
      entry: plan[name],
      ...(states?.[name] ? { state: states[name] } : {}),
      selected: name === selected,
      faint: !!near && !near.has(name),
    },
  }))
  const edges: Edge[] = laid.edges.map(({ from, to, need }) => {
    const lit = !!near && near.has(from) && near.has(to)
    const faint = !!near && !lit
    const color = lit ? 'var(--color-emerald-500)' : 'var(--color-stone-400)'
    return {
      id: `${from}->${to}`,
      source: from,
      target: to,
      type: 'default',
      selectable: false,
      focusable: false,
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
      style: {
        stroke: color,
        strokeWidth: lit ? 2 : 1.5,
        opacity: faint ? 0.25 : 1,
        ...(need ? { strokeDasharray: '5 4' } : {}),
      },
    }
  })
  // as large as it reads well: the whole graph as wide as the page, no smaller than MIN_ZOOM
  // (wider ones are moved sideways), and as high as that makes it
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const element = box.current
    if (!element) {
      return
    }
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const zoom = width ? Math.min(1, Math.max(MIN_ZOOM, width / (laid.width + 32))) : 1
  const height = Math.max(160, Math.ceil((laid.height + 32) * zoom))
  return (
    <div
      className="task-graph overflow-hidden rounded-lg border border-stone-200 bg-stone-50 dark:border-stone-800 dark:bg-stone-950"
      ref={box}
      style={{ height }}
    >
      <ReactFlow
        key={`${key}\n${Math.round(zoom * 100)}`}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        colorMode="system"
        // from its start, in the middle when it is narrower than the page
        defaultViewport={{ x: Math.max(16, (width - laid.width * zoom) / 2), y: 16, zoom }}
        minZoom={0.2}
        maxZoom={1.5}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        zoomOnScroll={false}
        preventScrolling={false}
        onNodeClick={(_, node) => onSelect(node.id)}
        onPaneClick={() => onSelect(null)}
      >
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </div>
  )
}
