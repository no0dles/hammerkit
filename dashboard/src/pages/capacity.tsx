import { useApi, useSession, type Capacity } from '../api'
import type { CapacityGroup, Resources } from '../../../src/server/capacity'
import { formatCpu, formatMemory, plural } from '../format'
import { Bar, Card, Code, Quiet, RunLink, Section, T, Table, Td, Time, useNow } from '../ui'

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
    const lines = [
      requested !== undefined && kubernetes ? `runs requested ${format(requested)}` : '',
      used !== undefined ? `runs use ${format(used)}` : '',
      usedAll !== undefined ? `${kubernetes ? 'the nodes use' : 'the machine uses'} ${format(usedAll)}` : '',
    ].filter(Boolean)
    return (
      <Card className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <strong className="text-sm">{name}</strong>
          {max !== undefined ? (
            <Quiet>
              <span className="text-sm">
                {format(max)} on {kubernetes ? plural(machines?.count ?? 0, 'node') : 'the machine'}
              </span>
            </Quiet>
          ) : null}
        </div>
        <Bar value={kubernetes ? requested ?? used : used ?? usedAll} max={max} also={usedAll} />
        <div className="text-xs">{lines.join(' · ') || <Quiet>not known</Quiet>}</div>
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
  const owner = (group: CapacityGroup) =>
    group.owner ? (
      <>
        {group.owner.iss === session.data?.iss && group.owner.sub === session.data?.sub ? (
          'yours'
        ) : (
          <T>{group.owner.sub}</T>
        )}
        {group.run ? (
          <>
            {' · '}
            <RunLink id={group.run} />
          </>
        ) : null}
      </>
    ) : (
      <Quiet>no run the server keeps</Quiet>
    )
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
      {data.groups.length > 0 ? (
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-medium">
            Namespaces <Quiet>{data.groups.length}</Quiet>
          </h3>
          <Table head={['Namespace', 'Whose', 'Pods', 'Requested', 'Quota', 'In use']}>
            {data.groups.map((group) => (
              <tr key={group.name}>
                <Td>
                  <Code>{group.name}</Code>
                  <div className="text-xs text-stone-500">
                    {group.kind === 'service-run' ? 'a service run' : 'runs of a caller'}
                  </div>
                </Td>
                <Td>{owner(group)}</Td>
                <Td num>{group.pods}</Td>
                <Td className="whitespace-nowrap">
                  {resources(group.requested)}
                  {group.quota ? (
                    <div className="mt-1">
                      <Bar value={group.requested.cpu} max={group.quota.cpu} />
                    </div>
                  ) : null}
                </Td>
                <Td className="whitespace-nowrap">{group.quota ? resources(group.quota) : <Quiet>none</Quiet>}</Td>
                <Td className="whitespace-nowrap">{resources(group.used)}</Td>
              </tr>
            ))}
          </Table>
        </div>
      ) : null}
      {data.problems.length > 0 ? (
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-medium">Not shown</h3>
          <ul className="list-disc pl-5 text-sm">
            {data.problems.map((problem) => (
              <li key={problem}>
                <T>{problem}</T>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Section>
  )
}
