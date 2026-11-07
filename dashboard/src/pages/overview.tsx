import { Link } from 'react-router'
import { useApi, type Capacity, type ListedRun, type Overview } from '../api'
import { describeWait, ranMs, span, waitedMs } from '../format'
import { Card, Empty, Loading, Meter, Owner, PageTitle, Quiet, RunLink, Section, Time, useNow, Work } from '../ui'
import { CapacityMeters } from './capacity'
import { ServiceTable } from './services'

export function OverviewPage() {
  const overview = useApi<Overview>('/overview')
  const capacity = useApi<Capacity>('/capacity')
  const now = useNow()
  return (
    <>
      <PageTitle>Overview</PageTitle>
      <Loading query={overview}>
        {(data) => (
          <>
            <Places overview={data} now={now} />
            <Queue overview={data} now={now} />
            {capacity.data ? (
              <Section
                title="Capacity"
                note={
                  <Link className="link" to="/capacity">
                    more
                  </Link>
                }
              >
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <CapacityMeters capacity={capacity.data} />
                </div>
              </Section>
            ) : null}
            <Section title="Your limits" note="and the runs that count against them">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                <Meter name="Running" meter={data.limits.running} setting="runs.limits.running" />
                <Meter name="Queued" meter={data.limits.queued} setting="runs.limits.queued" />
                <Meter name="Waiting for approval" meter={data.limits.waiting} setting="runs.limits.waiting" />
                <Meter name="Service runs" meter={data.limits.services} setting="runs.up.limits.up" />
                {data.limits.asleep ? (
                  <Meter name="Asleep" meter={data.limits.asleep} setting="runs.up.limits.asleep" />
                ) : null}
              </div>
            </Section>
            <Approvals overview={data} now={now} />
            <Section
              title="Service runs"
              note={`${data.services.open}${
                data.services.max !== undefined ? ` of ${data.services.max}` : ''
              } places taken on the server`}
            >
              {data.services.runs.length > 0 ? (
                <ServiceTable runs={data.services.runs} now={now} />
              ) : (
                <Empty>None you may see is starting, up or asleep.</Empty>
              )}
            </Section>
          </>
        )}
      </Loading>
    </>
  )
}

function Places({ overview, now }: { overview: Overview; now: number }) {
  const { places } = overview
  const unaccounted = Math.max(0, places.used - places.runs.length - places.others)
  const free = Math.max(0, places.max - places.used)
  const slot = 'flex min-h-20 flex-col gap-1 rounded-lg border p-3 text-sm'
  return (
    <Section title="Places" note={`${places.used} of ${places.max} taken (runs.maxConcurrent)`}>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {places.runs.map((run) => (
          <li
            key={run.id}
            className={`${slot} ${
              run.owner
                ? 'border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900'
                : 'border-emerald-600 bg-emerald-50 dark:border-emerald-500 dark:bg-emerald-950'
            }`}
          >
            <RunLink id={run.id} />
            <span>
              <Work run={run} />
              <Owner run={run} />
            </span>
            {run.startedAt ? <Quiet>running for {span(ranMs(run, now))}</Quiet> : null}
          </li>
        ))}
        {Array.from({ length: places.others }, (_, index) => (
          <li key={`other-${index}`} className={`${slot} border-stone-200 text-stone-500 dark:border-stone-800`}>
            somebody else
          </li>
        ))}
        {Array.from({ length: unaccounted }, (_, index) => (
          <li key={`warn-${index}`} className={`${slot} border-amber-500 text-amber-700 dark:text-amber-400`}>
            taken by no running run
          </li>
        ))}
        {Array.from({ length: free }, (_, index) => (
          <li
            key={`free-${index}`}
            className={`${slot} border-dashed border-stone-300 text-stone-400 dark:border-stone-700 dark:text-stone-500`}
          >
            free
          </li>
        ))}
      </ul>
    </Section>
  )
}

function Queue({ overview, now }: { overview: Overview; now: number }) {
  return (
    <Section title="Queue" note="in the order runs start">
      {overview.queue.length === 0 ? (
        <Empty>Nothing waits for a place.</Empty>
      ) : (
        <ol className="flex flex-col gap-2">
          {overview.queue.map((entry) => (
            <li
              key={entry.position}
              className={`flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-lg border p-3 text-sm ${
                entry.mine
                  ? 'border-emerald-600/40 bg-emerald-50 dark:bg-emerald-950'
                  : 'border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900'
              }`}
            >
              <span className="flex-1">
                <Quiet>{entry.position}. </Quiet>
                {entry.run ? (
                  <>
                    <RunLink id={entry.run.id} /> <Work run={entry.run} />
                    <Owner run={entry.run} />
                  </>
                ) : (
                  'a run of somebody else'
                )}
              </span>
              <span className="text-xs text-stone-500 dark:text-stone-400">
                {entry.run ? `waiting ${span(waitedMs(entry.run, now))} · ` : ''}waits:{' '}
                {describeWait(entry.waitsFor, entry.mine, false)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Section>
  )
}

function Approvals({ overview, now }: { overview: Overview; now: number }) {
  const runs: ListedRun[] = overview.approvals.runs
  return (
    <Section
      title="Waiting for an approval"
      note={
        <>
          {overview.approvals.waiting} of at most {overview.approvals.max} on the server ·{' '}
          <Link className="link" to="/approvals">
            decide
          </Link>
        </>
      }
    >
      {runs.length === 0 ? (
        <Empty>None you may see.</Empty>
      ) : (
        <div className="flex flex-col gap-2">
          {runs.map((run) => (
            <Card key={run.id} className="text-sm">
              <RunLink id={run.id} /> <Work run={run} />
              <Owner run={run} />{' '}
              <Quiet>
                needs{' '}
                {(run.approvals ?? [])
                  .filter((approval) => !approval.approvedBy)
                  .map((approval) => approval.account)
                  .join(', ')}{' '}
                until <Time iso={run.approvals?.[0]?.expiresAt} now={now} />
              </Quiet>
            </Card>
          ))}
        </div>
      )}
    </Section>
  )
}
