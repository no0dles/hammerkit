import { useApi, type Overview } from '../api'
import { describeWait, span, waitedMs } from '../format'
import { Empty, Loading, Owner, PageTitle, Quiet, RunLink, Section, useNow, Work } from '../ui'
import { CapacitySection } from './capacity'
import { ServiceTable } from './services'

export function OverviewPage() {
  const overview = useApi<Overview>('/overview')
  const now = useNow()
  return (
    <>
      <PageTitle>Overview</PageTitle>
      <Loading query={overview}>
        {(data) => (
          <>
            <Queue overview={data} now={now} />
            <CapacitySection />
            <Section
              title="Services"
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

// shown only while runs wait for a place
function Queue({ overview, now }: { overview: Overview; now: number }) {
  if (overview.queue.length === 0) {
    return null
  }
  return (
    <Section title="Queue" note="in the order runs start">
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
    </Section>
  )
}
