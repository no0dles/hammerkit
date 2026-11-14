import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import type { TaskPlan } from './api'
import type { DefinitionInputs } from '../../src/server/definitions'
import { printable } from './format'
import { Arguments, Code, Quiet, T } from './ui'

/**
 * The tasks and services of a build file as a graph: a box each, an arrow from what a task
 * depends on to it (dashed from a service it needs), laid out from left to right in the order
 * they run. A click on a box opens it in a panel beside the page (TaskPanel), which the build
 * file pages and the run page share; the run page colors the boxes by how each task went.
 */

// how a run says a task went, for its box: its state and a few words (how long it took)
export interface NodeState {
  state: string
  note?: string
}

export interface TaskGraphProps {
  plan: Record<string, TaskPlan>
  // the boxes, in the order they are listed; every task and service of the plan by default
  names?: string[]
  // a run's: how each task went
  states?: Record<string, NodeState>
  selected: string | null
  onSelect: (name: string | null) => void
}

const Canvas = lazy(() => import('./graph-canvas'))

export function TaskGraph(props: TaskGraphProps) {
  return (
    <Suspense
      fallback={
        <div className="flex h-40 items-center justify-center rounded-lg border border-stone-200 bg-stone-50 text-sm text-stone-500 dark:border-stone-800 dark:bg-stone-950">
          drawing the graph…
        </div>
      }
    >
      <Canvas {...props} />
    </Suspense>
  )
}

// The legend of the graph: what a box, a dashed box and an arrow say
export function GraphLegend({ run = false }: { run?: boolean }) {
  return (
    <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-600 dark:text-stone-300">
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="inline-block h-3 w-4 rounded-sm border-2 border-stone-400" />
        task
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="inline-block h-3 w-4 rounded-full border-2 border-violet-400" />
        service
      </li>
      {run ? null : (
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-3 w-4 rounded-sm border-2 border-dashed border-stone-400" />
          groups its dependencies
        </li>
      )}
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="inline-block h-0 w-5 border-t-2 border-stone-400" />
        runs after
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="inline-block h-0 w-5 border-t-2 border-dashed border-stone-400" />
        needs the service
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-amber-500" />
        to look at
      </li>
    </ul>
  )
}

// The tasks and services of a build file as a graph, a click on one opens it beside the page
export function PlanGraph({
  plan,
  inputs,
}: {
  plan: Record<string, TaskPlan>
  inputs?: Record<string, DefinitionInputs>
}) {
  const [selected, setSelected] = useState<string | null>(null)
  if (Object.keys(plan).length === 0) {
    return <Quiet>It has no tasks or services.</Quiet>
  }
  return (
    <>
      <GraphLegend />
      <TaskGraph plan={plan} selected={selected} onSelect={setSelected} />
      {selected ? (
        <TaskPanel
          title={selected}
          tabs={[
            {
              name: 'Task',
              content: <TaskFacts name={selected} plan={plan} inputs={inputs} onSelect={setSelected} />,
            },
          ]}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </>
  )
}

// The files of a build file version, each folded until it is opened
export function BuildFiles({ files, open = false }: { files: Record<string, string>; open?: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      {Object.entries(files).map(([name, text]) => (
        <details
          key={name}
          open={open}
          className="group rounded-lg border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900"
        >
          <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm">
            <span aria-hidden className="text-stone-400 transition-transform group-open:rotate-90">
              ›
            </span>
            <Code>{name}</Code>
            <Quiet>{text.split('\n').length} lines</Quiet>
          </summary>
          <pre className="log rounded-t-none">{printable(text)}</pre>
        </details>
      ))}
    </div>
  )
}

// One row of the panel: a name, and what it says or `none`
function Row({ name, children }: { name: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-stone-500 dark:text-stone-400">{name}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  )
}

// a version published before the plan named them in the bundle has them in the directory the
// server read it in
function inBundle(path: string): string {
  return path.replace(/^.*[\\/]hammerkit-definition-[^\\/]+[\\/]/, '')
}

// names a click selects, as buttons, or `none`
function Names({ names, onSelect }: { names: string[]; onSelect: (name: string) => void }) {
  if (names.length === 0) {
    return <Quiet>none</Quiet>
  }
  return (
    <span className="flex flex-wrap gap-1.5">
      {names.map((name) => (
        <button
          key={name}
          type="button"
          onClick={() => onSelect(name)}
          className="cursor-pointer rounded bg-stone-100 px-1.5 font-mono text-[0.8rem] hover:bg-stone-200 dark:bg-stone-800 dark:hover:bg-stone-700"
        >
          {printable(name)}
        </button>
      ))}
    </span>
  )
}

function List({ items }: { items: string[] }) {
  if (items.length === 0) {
    return <Quiet>none</Quiet>
  }
  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((item, i) => (
        <li key={i}>
          <Code>{item}</Code>
        </li>
      ))}
    </ul>
  )
}

// What a task or service does, whole: what the build file says of it
export function TaskFacts({
  name,
  plan,
  inputs,
  args,
  onSelect,
}: {
  name: string
  plan: Record<string, TaskPlan>
  inputs?: Record<string, DefinitionInputs>
  args?: unknown
  onSelect: (name: string) => void
}) {
  const entry = plan[name]
  if (!entry) {
    return <Quiet>The build file says nothing of {name}.</Quiet>
  }
  const dependents = Object.entries(plan)
    .filter(([, other]) => other.deps.includes(name) || other.needs.includes(name))
    .map(([other]) => other)
  const network = entry.network
  return (
    <div className="flex flex-col gap-4 text-sm">
      {entry.description ? (
        <p>
          <T>{entry.description}</T>
        </p>
      ) : null}
      {entry.flags.length > 0 ? (
        <p className="rounded-md border border-amber-500/50 bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          To look at: {entry.flags.join(', ')}
        </p>
      ) : null}
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5">
        <Row name="Kind">
          {entry.kind}, {entry.runtime === 'none' ? 'runs nothing' : entry.runtime}
        </Row>
        {entry.image ? (
          <Row name="Image">
            <Code>{entry.image}</Code>
          </Row>
        ) : null}
        <Row name="Runs after">
          <Names names={entry.deps} onSelect={onSelect} />
        </Row>
        <Row name="Needs">
          <Names names={entry.needs} onSelect={onSelect} />
        </Row>
        <Row name={entry.kind === 'service' ? 'Needed by' : 'Before'}>
          <Names names={dependents} onSelect={onSelect} />
        </Row>
      </dl>
      {entry.cmds.length > 0 ? (
        <div>
          <h3 className="mb-1 text-xs font-medium tracking-wide text-stone-500 uppercase dark:text-stone-400">
            {entry.kind === 'service' ? 'Command' : 'Commands'}
          </h3>
          <Arguments args={args} />
          <pre className="log whitespace-pre-wrap">{entry.cmds.map((cmd) => `$ ${printable(cmd)}`).join('\n')}</pre>
        </div>
      ) : null}
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5">
        {inputs?.[name] ? (
          <Row name="Sources">
            <List items={inputs[name].src} />
          </Row>
        ) : null}
        <Row name="Generates">
          <List items={entry.generates.map(inBundle)} />
        </Row>
        <Row name="Secrets">
          {entry.secrets.length > 0 ? (
            <ul className="flex flex-col gap-0.5">
              {entry.secrets.map((secret, i) => (
                <li key={i}>
                  <Code>{secret.target}</Code> <Quiet>from</Quiet> <Code>{secret.from}</Code>
                  {secret.account ? (
                    <>
                      {' '}
                      <Quiet>as</Quiet> <Code>{secret.account}</Code>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <Quiet>none</Quiet>
          )}
        </Row>
        {entry.accounts.length > 0 ? (
          <Row name="Accounts">
            <T>{entry.accounts.join(', ')}</T>
          </Row>
        ) : null}
        {entry.serverEnvs?.length ? (
          <Row name="Server variables">
            <List items={entry.serverEnvs} />
          </Row>
        ) : null}
        {network ? (
          <Row name="Network">
            {typeof network === 'string' ? (
              network
            ) : (
              <>
                only <T>{network.allow.join(', ')}</T>
              </>
            )}
          </Row>
        ) : null}
        {entry.mounts.length > 0 ? (
          <Row name="Mounts">
            <List items={entry.mounts} />
          </Row>
        ) : null}
        {entry.ports.length > 0 ? (
          <Row name="Ports">
            <List items={entry.ports} />
          </Row>
        ) : null}
        {entry.capAdd?.length ? (
          <Row name="Capabilities">
            <List items={entry.capAdd} />
          </Row>
        ) : null}
        {entry.args !== undefined ? <Row name="Arguments">{entry.args ? 'taken' : 'refused'}</Row> : null}
      </dl>
    </div>
  )
}

// A panel at the side of the page over what is there, with tabs where it has more than one;
// Escape or × closes it.
export function TaskPanel({
  title,
  status,
  tabs,
  onClose,
}: {
  title: string
  // beside the title: a run's state of the task
  status?: ReactNode
  tabs: { name: string; content: ReactNode }[]
  onClose: () => void
}) {
  const [tab, setTab] = useState(tabs[0]?.name)
  const shown = tabs.find((each) => each.name === tab) ?? tabs[0]
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <aside
      aria-label={title}
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-lg flex-col border-l border-stone-200 bg-white shadow-2xl dark:border-stone-800 dark:bg-stone-900"
    >
      <header className="flex items-center gap-2 border-b border-stone-200 px-4 py-3 dark:border-stone-800">
        <h2 className="min-w-0 flex-1 truncate font-mono text-sm font-semibold">{printable(title)}</h2>
        {status}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="cursor-pointer rounded-md px-2 py-0.5 text-lg leading-none text-stone-500 hover:bg-stone-100 hover:text-stone-900 dark:hover:bg-stone-800 dark:hover:text-white"
        >
          ×
        </button>
      </header>
      {tabs.length > 1 ? (
        <div role="tablist" aria-label={`What ${title} shows`} className="flex gap-1 px-4 pt-3 text-sm">
          {tabs.map((each) => (
            <button
              key={each.name}
              type="button"
              role="tab"
              aria-selected={each === shown}
              onClick={() => setTab(each.name)}
              className={`cursor-pointer rounded-md px-2.5 py-0.5 ${
                each === shown
                  ? 'bg-stone-200 font-medium text-stone-900 dark:bg-stone-700 dark:text-white'
                  : 'text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800'
              }`}
            >
              {each.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">{shown?.content}</div>
    </aside>
  )
}
