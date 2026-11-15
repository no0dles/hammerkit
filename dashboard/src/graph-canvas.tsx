import { useEffect, useMemo, useRef, useState } from 'react'
import { Handle, MarkerType, Position, ReactFlow, Controls, type Edge, type Node, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import dagre from '@dagrejs/dagre'
import type { TaskPlan } from './api'
import type { NodeState, TaskGraphProps } from './graph'
import { printable } from './format'
import { StateMark } from './ui'

// The graph of TaskGraph (graph.tsx), drawn by React Flow: the services in a row on top, the
// tasks below laid out by dagre from left to right in the order they run, an arrow from what a
// task depends on to it. What ties a task to a service shows only while one of them is hovered or
// opened, so the arrows between the tasks stay readable.

const NODE_WIDTH = 184
const NODE_HEIGHT = 52
const GAP = 14
// between the row of services and the tasks below it
const SERVICE_GAP = 56
// the smallest a graph is drawn at first, where its names still read
const MIN_ZOOM = 0.6

interface TaskNodeData extends Record<string, unknown> {
  name: string
  entry: TaskPlan | undefined
  state?: NodeState
  // what the box says below its name when no run says how it went
  note?: string
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
    return entry.image
  }
  return entry.kind === 'service' ? 'service' : `${entry.runtime}, ${entry.cmds.length} cmds`
}

const isService = (entry: TaskPlan | undefined) => entry?.kind === 'service'

// the handles an arrow starts and ends at: between tasks from right to left, from a service
// in the row above down to the top of a task that needs it, and up from a task a service waits for
const HANDLES = [
  { id: 'in', type: 'target', position: Position.Left },
  { id: 'out', type: 'source', position: Position.Right },
  { id: 'top-in', type: 'target', position: Position.Top },
  { id: 'top-out', type: 'source', position: Position.Top },
  { id: 'bottom-in', type: 'target', position: Position.Bottom },
  { id: 'bottom-out', type: 'source', position: Position.Bottom },
] as const

function TaskBox({ data }: NodeProps<TaskNode>) {
  const { name, entry, state, note, selected, faint } = data
  const service = isService(entry)
  const aggregate = entry?.runtime === 'none' && !service
  const border = state ? STATE_BORDER[state.state] ?? 'border-stone-300 dark:border-stone-600' : ''
  const sub = state ? [state.state, state.note].filter(Boolean).join(' · ') : note ?? describe(entry)
  const needs = entry && !service ? entry.needs : []
  return (
    <>
      {HANDLES.map((handle) => (
        <Handle
          key={handle.id}
          id={handle.id}
          type={handle.type}
          position={handle.position}
          isConnectable={false}
          className="invisible"
        />
      ))}
      <button
        // the click reaches the graph's onNodeClick, Enter and Space as one too
        type="button"
        aria-pressed={selected}
        title={`${name}${sub ? `: ${sub}` : ''}${needs.length > 0 ? `\nneeds ${needs.join(', ')}` : ''}`}
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
        {needs.length > 0 ? (
          // the services it needs, whose arrows show on hover
          <span
            aria-label={`needs ${needs.length} services`}
            className="shrink-0 rounded-full border border-violet-400 px-1 text-[0.65rem] leading-tight text-violet-700 tabular-nums dark:border-violet-500 dark:text-violet-300"
          >
            {needs.length}
          </span>
        ) : null}
        {entry?.flags.length ? (
          <span
            role="img"
            aria-label={`look at: ${entry.flags.join(', ')}`}
            className="h-2 w-2 shrink-0 rounded-full bg-amber-500"
          />
        ) : null}
      </button>
    </>
  )
}

// the line between the services on top and the tasks below
const DIVIDER = '\0divider'
function Divider() {
  return (
    <div className="pointer-events-none h-px w-full border-t border-dashed border-stone-300 dark:border-stone-700" />
  )
}

const nodeTypes = { task: TaskBox, divider: Divider }

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

interface Link {
  from: string
  to: string
  // to or from a service: shown only while one of its ends is hovered or opened
  service: boolean
  // a task needs the service (dashed), not depends on it
  need: boolean
  sourceHandle: string
  targetHandle: string
}

// the arrows between what is shown: from what one depends on or needs to it
function links(plan: Record<string, TaskPlan>, names: string[]): Link[] {
  const shown = new Set(names)
  const result: Link[] = []
  for (const name of names) {
    const entry = plan[name]
    for (const [others, need] of [
      [entry?.deps ?? [], false],
      [entry?.needs ?? [], true],
    ] as const) {
      for (const other of others) {
        if (!shown.has(other)) {
          continue
        }
        const fromService = isService(plan[other])
        const toService = isService(entry)
        result.push({
          from: other,
          to: name,
          service: fromService || toService,
          need,
          // a service above a task: down into its top; a task a service waits for: up into the service
          ...(fromService && !toService
            ? { sourceHandle: 'bottom-out', targetHandle: 'top-in' }
            : toService && !fromService
              ? { sourceHandle: 'top-out', targetHandle: 'bottom-in' }
              : { sourceHandle: 'out', targetHandle: 'in' }),
        })
      }
    }
  }
  return result
}

// where each box goes: the services in rows on top, the tasks below in ranks from left to right
function layout(plan: Record<string, TaskPlan>, names: string[]) {
  const services = names.filter((name) => isService(plan[name]))
  const tasks = names.filter((name) => !isService(plan[name]))
  const positions = new Map<string, { x: number; y: number }>()
  let tasksWidth = 0
  let tasksHeight = 0
  if (tasks.length > 0) {
    const graph = new dagre.graphlib.Graph()
    graph.setGraph({ rankdir: 'LR', nodesep: GAP, ranksep: 40, marginx: 0, marginy: 0 })
    graph.setDefaultEdgeLabel(() => ({}))
    for (const name of tasks) {
      graph.setNode(name, { width: NODE_WIDTH, height: NODE_HEIGHT })
    }
    for (const link of links(plan, tasks)) {
      graph.setEdge(link.from, link.to)
    }
    dagre.layout(graph)
    for (const name of tasks) {
      const node = graph.node(name)
      positions.set(name, { x: node.x - NODE_WIDTH / 2, y: node.y - NODE_HEIGHT / 2 })
    }
    tasksWidth = graph.graph().width ?? NODE_WIDTH
    tasksHeight = graph.graph().height ?? NODE_HEIGHT
  }
  // as many in a row as fit above the tasks, at least four; more rows below each other when they don't
  const perRow = Math.max(4, Math.floor((tasksWidth + GAP) / (NODE_WIDTH + GAP)))
  const rows = Math.ceil(services.length / perRow)
  const rowWidth = Math.min(services.length, perRow) * (NODE_WIDTH + GAP) - GAP
  const width = Math.max(tasksWidth, rowWidth)
  // the rows in the middle above the tasks when they are the narrower, the tasks below them
  const rowStart = (width - Math.max(rowWidth, 0)) / 2
  services.forEach((name, index) =>
    positions.set(name, {
      x: rowStart + (index % perRow) * (NODE_WIDTH + GAP),
      y: Math.floor(index / perRow) * (NODE_HEIGHT + GAP),
    })
  )
  const below = rows > 0 && tasks.length > 0 ? rows * (NODE_HEIGHT + GAP) - GAP + SERVICE_GAP : 0
  const tasksStart = (width - tasksWidth) / 2
  for (const name of tasks) {
    const at = positions.get(name)!
    positions.set(name, { x: at.x + tasksStart, y: at.y + below })
  }
  const height = tasks.length > 0 ? below + tasksHeight : rows * (NODE_HEIGHT + GAP) - GAP
  return {
    positions,
    links: links(plan, names),
    width,
    height,
    divider: below > 0 ? below - SERVICE_GAP / 2 : null,
  }
}

// loaded apart (graph.tsx), the pages without a graph do without the library
export default function TaskGraphCanvas({
  plan,
  names = Object.keys(plan),
  states,
  notes,
  selected,
  onSelect,
}: TaskGraphProps) {
  const key = names.join('\n')
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the layout changes with the names only
  const laid = useMemo(() => layout(plan, names), [plan, key])
  const near = useMemo(() => (selected ? related(plan, selected) : null), [plan, selected])
  const [hovered, setHovered] = useState<string | null>(null)
  const nodes: Node[] = names.map(
    (name): TaskNode => ({
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
        ...(notes?.[name] ? { note: notes[name] } : {}),
        selected: name === selected,
        faint: !!near && !near.has(name),
      },
    })
  )
  if (laid.divider !== null) {
    nodes.push({
      id: DIVIDER,
      type: 'divider',
      position: { x: 0, y: laid.divider },
      width: laid.width,
      height: 1,
      draggable: false,
      selectable: false,
      focusable: false,
      data: {},
    })
  }
  // the arrows to and from a service: of the hovered box, and of the opened one
  const shows = (link: Link) =>
    !link.service || [hovered, selected].some((name) => name === link.from || name === link.to)
  const edges: Edge[] = laid.links.filter(shows).map(({ from, to, service, need, sourceHandle, targetHandle }) => {
    const lit = !!near && near.has(from) && near.has(to)
    const faint = !!near && !lit
    const color = service ? 'var(--color-violet-500)' : lit ? 'var(--color-emerald-500)' : 'var(--color-stone-400)'
    return {
      id: `${from}->${to}`,
      source: from,
      target: to,
      sourceHandle,
      targetHandle,
      type: 'default',
      selectable: false,
      focusable: false,
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
      style: {
        stroke: color,
        strokeWidth: lit || service ? 2 : 1.5,
        opacity: faint && !service ? 0.25 : 1,
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
        onNodeClick={(_, node) => node.id !== DIVIDER && onSelect(node.id)}
        onNodeMouseEnter={(_, node) => node.id !== DIVIDER && setHovered(node.id)}
        onNodeMouseLeave={() => setHovered(null)}
        onPaneClick={() => onSelect(null)}
      >
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </div>
  )
}
