import { useApi, type ListedRun } from '../api'
import {
  Empty,
  Endpoints,
  Loading,
  Owner,
  PageTitle,
  Quiet,
  RunButtons,
  RunLink,
  Section,
  Sleeps,
  Source,
  State,
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
        Service runs
      </PageTitle>
      <Loading query={query}>
        {({ runs }) => {
          const groups: [string, ListedRun[]][] = [
            ['Up', runs.filter((run) => run.state === 'up')],
            ['Asleep', runs.filter((run) => run.state === 'asleep')],
            ['Starting', runs.filter((run) => ['awaiting-approval', 'queued', 'running'].includes(run.state))],
            [
              'Ended in the last day',
              runs.filter(
                (run) => FINAL.includes(run.state) && now - Date.parse(run.finishedAt ?? run.createdAt) < DAY
              ),
            ],
          ]
          return groups.map(([name, list]) => (
            <Section key={name} title={name} note={String(list.length)}>
              {list.length > 0 ? <ServiceTable runs={list} now={now} /> : <Empty>None.</Empty>}
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
            </div>
          </Td>
          <Td>
            <State state={run.state} />
            {run.wakes ? <div className="text-xs text-stone-500">woken {run.wakes}×</div> : null}
          </Td>
          <Td>
            <Endpoints run={run} />
          </Td>
          <Td>
            <Source run={run} />
          </Td>
          <Td className="whitespace-nowrap">
            {run.expiresAt ? <Time iso={run.expiresAt} now={now} /> : <Quiet>once up</Quiet>}
          </Td>
          <Td className="whitespace-nowrap">
            <Sleeps run={run} now={now} />
          </Td>
          <Td>
            <RunButtons run={run} />
          </Td>
        </tr>
      ))}
    </Table>
  )
}
