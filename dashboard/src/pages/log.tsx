import { useState, type FormEvent } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { useApi, type FullRun, type LogPage as Page } from '../api'
import { Button, Empty, inputClass, Loading, PageTitle, Quiet } from '../ui'
import { LogLines, LogNames } from './run'

const PAGE_LINES = 1000

// The whole log, a thousand lines a page, from the end; with a text to look for.
export function LogPage() {
  const id = useParams().id ?? ''
  const [params, setParams] = useSearchParams()
  const task = params.get('task') ?? undefined
  const grep = (params.get('grep') ?? '').replace(/[\r\n]/g, ' ').slice(0, 200) || undefined
  const fromParam = Number(params.get('from'))
  const from = Number.isInteger(fromParam) && fromParam >= 1 ? fromParam : undefined
  const [typed, setTyped] = useState(grep ?? '')
  const run = useApi<FullRun>(`/runs/${encodeURIComponent(id)}`, { refresh: false })
  const query = new URLSearchParams({ limit: String(PAGE_LINES) })
  if (task) {
    query.set('task', task)
  }
  if (grep) {
    query.set('grep', grep)
    query.set('i', 'true')
    query.set('context', '2')
  }
  if (from !== undefined) {
    query.set('from', String(from))
  } else if (!grep) {
    query.set('tail', String(PAGE_LINES))
  }
  // the end of a log that grows moves on; a page further back stays as it is
  const log = useApi<Page>(`/runs/${encodeURIComponent(id)}/logs?${query}`, { refresh: from === undefined })
  const link = (more: Record<string, string>) => {
    const next = new URLSearchParams({ ...(task ? { task } : {}), ...(grep ? { grep } : {}), ...more })
    return `/runs/${encodeURIComponent(id)}/log?${next}`
  }
  const look = (event: FormEvent) => {
    event.preventDefault()
    const next = new URLSearchParams(task ? { task } : {})
    if (typed.trim()) {
      next.set('grep', typed.trim())
    }
    setParams(next)
  }
  const suffix = task ? `?task=${encodeURIComponent(task)}` : ''
  return (
    <>
      <PageTitle>{`Log of ${id}`}</PageTitle>
      <p className="mb-3 text-sm">
        <Link className="link" to={`/runs/${encodeURIComponent(id)}`}>
          back to the run
        </Link>{' '}
        ·{' '}
        <a className="link" href={`/api/runs/${encodeURIComponent(id)}/log.txt${suffix}`} download>
          download
        </a>
      </p>
      {run.data ? (
        <LogNames
          run={run.data}
          names={log.data?.names ?? []}
          chosen={task}
          base={`/runs/${encodeURIComponent(id)}/log`}
        />
      ) : null}
      <form className="mb-3 flex flex-wrap items-center gap-2" onSubmit={look}>
        <input
          className={`${inputClass} min-w-0 flex-1 sm:max-w-sm`}
          value={typed}
          maxLength={200}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="look for a text"
          aria-label="Look for"
        />
        <Button type="submit">Look</Button>
        {grep ? (
          <Link className="link text-sm" to={`/runs/${encodeURIComponent(id)}/log${suffix}`}>
            show all
          </Link>
        ) : null}
      </form>
      <Loading query={log} missing={<Empty>The log of this run is for its owner and who decides about it.</Empty>}>
        {(page) => {
          const first = page.lines[0]?.line
          const last = page.lines[page.lines.length - 1]?.line
          const pager = (
            <div className="my-2 flex gap-4 text-sm">
              {!grep && first !== undefined && first > 1 ? (
                <Link className="link" to={link({ from: String(Math.max(1, first - PAGE_LINES)) })}>
                  earlier
                </Link>
              ) : null}
              {page.next !== undefined ? (
                <Link className="link" to={link({ from: String(page.next) })}>
                  later
                </Link>
              ) : null}
            </div>
          )
          return (
            <>
              <p className="text-sm">
                <Quiet>
                  {first !== undefined ? `lines ${first} to ${last} of ${page.total}` : `${page.total} lines`}
                  {grep ? `, with “${grep}” and two lines around` : ''}
                  {page.truncated ? ', cut off at runs.maxLogBytes' : ''}
                </Quiet>
              </p>
              {pager}
              <LogLines page={page} named={!task} />
              {pager}
            </>
          )
        }}
      </Loading>
    </>
  )
}
