import { useApi, type ListedRun } from '../api'
import {
  Empty,
  Endpoints,
  Loading,
  Owner,
  PageTitle,
  Quiet,
  ExtendButton,
  StartButton,
  StopButton,
  RunLink,
  Section,
  Sleeps,
  Source,
  StateIcon,
  T,
  Table,
  Td,
  Time,
  useNow,
} from '../ui'

const DAY = 24 * 60 * 60 * 1000
const FINAL = ['succeeded', 'failed', 'cancelled', 'rejected']

export function ServicesPage() {
  const query = useApi<{ runs: ListedRun[] }>('/runs?scope=visible&kind=services')
  const now = useNow()
  return (
    <>
      <PageTitle note="the services of runs that are up, asleep, starting, or ended in the last day">
        Services
      </PageTitle>
      <Loading query={query}>
        {({ runs }) => {
          const starting = runs.filter((run) => ['awaiting-approval', 'queued', 'running'].includes(run.state))
          // each group only while it has runs
          const groups = (
            [
              ['Starting', starting],
              ['Up', runs.filter((run) => run.state === 'up')],
              ['Asleep', runs.filter((run) => run.state === 'asleep')],
              [
                'Past',
                runs.filter(
                  (run) => FINAL.includes(run.state) && now - Date.parse(run.finishedAt ?? run.createdAt) < DAY
                ),
              ],
            ] as [string, ListedRun[]][]
          ).filter(([, list]) => list.length > 0)
          if (groups.length === 0) {
            return <Empty>No service run is starting, up or asleep, or ended in the last day.</Empty>
          }
          return groups.map(([name, list]) => (
            <Section key={name} title={name} note={String(list.length)}>
              <ServiceTable runs={list} now={now} />
            </Section>
          ))
        }}
      </Loading>
    </>
  )
}

export function ServiceTable({ runs, now }: { runs: ListedRun[]; now: number }) {
  return (
    <Table head={['Name', 'State', 'Endpoints', 'Source', 'Ends', 'Sleeps', '']}>
      {runs.map((run) => (
        <tr key={run.id}>
          <Td>
            <RunLink id={run.id}>
              <T>{run.up?.name ?? run.id}</T>
            </RunLink>
            <Owner run={run} />
            <div className="text-xs text-stone-500 dark:text-stone-400">
              <T>{(run.up?.services ?? []).join(', ')}</T>
              {run.wakes ? ` · woken ${run.wakes}×` : null}
            </div>
          </Td>
          <Td>
            <StateIcon state={run.state} detail={run.wakes ? `woken ${run.wakes}×` : undefined} />
          </Td>
          <Td>
            <Endpoints run={run} />
          </Td>
          <Td>
            <Source run={run} />
          </Td>
          <Td className="whitespace-nowrap">
            <span className="inline-flex items-center gap-2">
              {run.expiresAt ? <Time iso={run.expiresAt} now={now} /> : <Quiet>once up</Quiet>}
              <ExtendButton run={run} />
            </span>
          </Td>
          <Td className="whitespace-nowrap">
            <Sleeps run={run} now={now} />
          </Td>
          <Td>
            <span className="inline-flex items-start gap-2">
              <StartButton run={run} />
              <StopButton run={run} />
            </span>
          </Td>
        </tr>
      ))}
    </Table>
  )
}
