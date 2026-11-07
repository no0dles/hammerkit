import { useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router'
import { useApi, useSession, type ListedRun } from '../api'
import { cut, printable, ranMs, span, waitedMs } from '../format'
import {
  Button,
  Empty,
  inputClass,
  Loading,
  Owner,
  PageTitle,
  RunLink,
  Source,
  State,
  Table,
  Td,
  Time,
  useNow,
  Work,
} from '../ui'

const STATES = [
  'awaiting-approval',
  'queued',
  'running',
  'up',
  'asleep',
  'succeeded',
  'failed',
  'cancelled',
  'rejected',
]
const ACTIVE = 'awaiting-approval,queued,running,up,asleep'

export function RunsPage() {
  const session = useSession()
  const [params, setParams] = useSearchParams()
  const seesOthers = !!session.data?.seesOthers
  const who = params.get('who') ?? (seesOthers ? 'all' : 'mine')
  const state = params.get('state') ?? ''
  const kind = params.get('kind') ?? ''
  const text = (params.get('q') ?? '').slice(0, 100)
  const [typed, setTyped] = useState(text)
  const query = new URLSearchParams({ scope: who === 'all' ? 'visible' : 'mine' })
  if (state) {
    query.set('state', state === 'active' ? ACTIVE : state)
  }
  if (kind === 'tasks' || kind === 'services') {
    query.set('kind', kind)
  }
  const runs = useApi<{ runs: ListedRun[] }>(`/runs?${query}`)
  const now = useNow()
  const change = (name: string, value: string) => {
    const next = new URLSearchParams(params)
    value ? next.set(name, value) : next.delete(name)
    setParams(next, { replace: true })
  }
  const search = (event: FormEvent) => {
    event.preventDefault()
    change('q', typed.trim())
  }
  return (
    <>
      <PageTitle>Runs</PageTitle>
      <form className="mb-4 flex flex-wrap items-center gap-2" onSubmit={search}>
        <select className={inputClass} value={who} onChange={(e) => change('who', e.target.value)} aria-label="Whose">
          <option value="all">{seesOthers ? 'everybody' : 'mine and those I may see'}</option>
          <option value="mine">mine</option>
        </select>
        <select
          className={inputClass}
          value={state}
          onChange={(e) => change('state', e.target.value)}
          aria-label="State"
        >
          <option value="">any state</option>
          <option value="active">not over</option>
          {STATES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select className={inputClass} value={kind} onChange={(e) => change('kind', e.target.value)} aria-label="Kind">
          <option value="">tasks and services</option>
          <option value="tasks">tasks</option>
          <option value="services">services</option>
        </select>
        <input
          className={`${inputClass} min-w-0 flex-1 sm:max-w-xs`}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="task, service, ref, person, id"
          aria-label="Search"
        />
        <Button type="submit">Show</Button>
      </form>
      <Loading query={runs}>
        {(data) => {
          const shown = data.runs.filter((run) => !text || matchesText(run, text))
          if (shown.length === 0) {
            return <Empty>No runs the server keeps are like that.</Empty>
          }
          return (
            <Table head={['Run', 'State', 'What', 'Source', 'Created', 'Waited', 'Ran']}>
              {shown.map((run) => (
                <tr key={run.id}>
                  <Td>
                    <RunLink id={run.id} />
                    <Owner run={run} />
                  </Td>
                  <Td>
                    <State state={run.state} />
                    {run.queue ? (
                      <div className="text-xs text-stone-500">{run.queue.position}. in the queue</div>
                    ) : null}
                  </Td>
                  <Td>
                    <Work run={run} />
                    {run.error ? (
                      <div className="text-xs whitespace-pre-wrap text-red-700 dark:text-red-400">
                        {printable(cut(run.error, 200))}
                      </div>
                    ) : null}
                  </Td>
                  <Td>
                    <Source run={run} />
                  </Td>
                  <Td className="whitespace-nowrap">
                    <Time iso={run.createdAt} now={now} />
                  </Td>
                  <Td num>{span(waitedMs(run, now))}</Td>
                  <Td num>{span(ranMs(run, now))}</Td>
                </tr>
              ))}
            </Table>
          )
        }}
      </Loading>
    </>
  )
}

function matchesText(run: ListedRun, text: string): boolean {
  const needle = text.toLowerCase()
  const haystack = [
    run.id,
    run.owner?.sub ?? '',
    ...run.tasks,
    ...(run.up ? [run.up.name, ...run.up.services] : []),
    run.source.type === 'upload' ? '' : run.source.repo,
    run.source.type === 'ref' ? run.source.ref : '',
  ]
  return haystack.some((value) => value.toLowerCase().includes(needle))
}
