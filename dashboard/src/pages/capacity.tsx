import { useApi, useSession, type Capacity } from '../api'
import type { CapacityUse, Resources } from '../../../src/server/capacity'
import { formatCpu, formatMemory, plural } from '../format'
import { Bar, Card, Code, Person, Quiet, RunLink, Section, T, Table, Td, Time, useNow } from '../ui'

const cores = (n: number) => `${formatCpu(n)} ${n === 1 ? 'core' : 'cores'}`

// CPU and memory: what the runs requested and use, of what the machines have
export function CapacityMeters({ capacity }: { capacity: Capacity }) {
  const { machines, runs } = capacity
  const kubernetes = capacity.backend === 'kubernetes'
  const meter = (name: string, kind: 'cpu' | 'memory') => {
    const format = kind === 'cpu' ? cores : formatMemory
    const max = machines?.allocatable[kind]
    const used = runs.used?.[kind]
    const requested = runs.requested[kind]
    const usedAll = machines?.used?.[kind]
    // what the bar shows: on Kubernetes what runs requested, on a host what they use
    const value = kubernetes ? requested ?? used : used ?? usedAll
    // the parts of it, on hover
    const lines = [
      requested !== undefined && kubernetes ? `runs requested ${format(requested)}` : '',
      used !== undefined ? `runs use ${format(used)}` : '',
      usedAll !== undefined ? `${kubernetes ? 'the nodes use' : 'the machine uses'} ${format(usedAll)}` : '',
    ].filter(Boolean)
    // what is missing, with why in a few words: no bar from 0 without a total
    const reason = (why: string | undefined) => (why ? ` (${why})` : '')
    const unknown = [
      max === undefined ? `total${reason(capacity.unknown?.total)}` : '',
      used === undefined && usedAll === undefined ? `use${reason(capacity.unknown?.used)}` : '',
    ].filter(Boolean)
    return (
      <Card className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <strong className="text-sm">{name}</strong>
          {max !== undefined ? (
            <span className="text-sm tabular-nums" title={lines.join(' · ') || undefined}>
              {value !== undefined ? `${kind === 'cpu' ? formatCpu(value) : formatMemory(value)} ` : ''}
              <Quiet>of {format(max)}</Quiet>
            </span>
          ) : null}
        </div>
        {max !== undefined ? <Bar value={value} max={max} also={usedAll} /> : null}
        {unknown.length > 0 ? (
          <div className="text-xs">
            <Quiet>not known: {unknown.join(' · ')}</Quiet>
          </div>
        ) : null}
      </Card>
    )
  }
  return (
    <>
      {meter('CPU', 'cpu')}
      {meter('Memory', 'memory')}
      {machines?.load ? (
        <Card className="flex flex-col gap-2">
          <strong className="text-sm">Load</strong>
          <div className="text-sm tabular-nums">
            {machines.load.map((l) => l.toFixed(2)).join(' · ')} <Quiet>(1, 5, 15 min)</Quiet>
          </div>
        </Card>
      ) : null}
    </>
  )
}

function resources(value: Resources | undefined) {
  return value ? `${formatCpu(value.cpu)} CPU · ${formatMemory(value.memory)}` : <Quiet>?</Quiet>
}

// What the machines have and what runs take of it, as a part of the overview.
export function CapacitySection() {
  const capacity = useApi<Capacity>('/capacity')
  const session = useSession()
  const now = useNow()
  const whose = (use: CapacityUse) =>
    !use.owner ? (
      <Quiet>somebody else</Quiet>
    ) : use.owner.iss === session.data?.iss && use.owner.sub === session.data?.sub ? (
      'yours'
    ) : (
      <Person who={use.owner} />
    )
  // what the pods are for, as the pages of runs and services name it
  const what = (use: CapacityUse) =>
    use.run ? (
      <>
        <RunLink id={use.run} />{' '}
        {use.up ? (
          <span>
            <Code>{use.up.name}</Code>: up <T>{use.up.services.join(', ')}</T>
          </span>
        ) : (
          <T>{(use.tasks ?? []).join(', ')}</T>
        )}
        {use.repo ? (
          <div className="text-xs text-stone-500 dark:text-stone-400">
            <T>{use.repo}</T>
          </div>
        ) : null}
      </>
    ) : use.kind === 'run' ? (
      <Quiet>a run of somebody else</Quiet>
    ) : use.kind === 'sandbox' ? (
      'a sandbox: its files and commands'
    ) : (
      <Quiet>pods of no run the server keeps</Quiet>
    )
  const uses = capacity.data?.uses ?? []
  // a server that does not tell what its machines have shows no capacity
  const data = capacity.data
  if (!data) {
    return null
  }
  return (
    <Section
      title="Capacity"
      note={
        <>
          {data.backend === 'kubernetes' ? 'on Kubernetes' : 'on a host'}, read <Time iso={data.at} now={now} />
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <CapacityMeters capacity={data} />
        <Card className="flex flex-col gap-2">
          <strong className="text-sm">Runs</strong>
          <div className="text-xs">
            {data.runs.pods !== undefined ? `${plural(data.runs.pods, 'pod')} · ` : ''}
            {data.runs.containers !== undefined ? `${plural(data.runs.containers, 'container')} · ` : ''}
            requested {resources(data.runs.requested)}
            {data.runs.used ? <> · in use {resources(data.runs.used)}</> : null}
          </div>
        </Card>
      </div>
      {uses.length > 0 ? (
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-medium">Active resources</h3>
          <Table head={['What', 'Whose', 'Requested', 'In use']}>
            {uses.map((use, index) => (
              <tr key={use.run ?? index}>
                <Td>{what(use)}</Td>
                <Td>{whose(use)}</Td>
                <Td className="whitespace-nowrap">{resources(use.requested)}</Td>
                <Td className="whitespace-nowrap">{resources(use.used)}</Td>
              </tr>
            ))}
          </Table>
        </div>
      ) : null}
    </Section>
  )
}
