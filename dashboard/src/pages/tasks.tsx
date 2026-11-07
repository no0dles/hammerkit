import { useState } from 'react'
import { useApi, useSession, type TaskStats } from '../api'
import { span } from '../format'
import { Code, Empty, inputClass, Loading, PageTitle, Quiet, State, T, Table, Td, Time, useNow } from '../ui'

// What the past runs of each task took, over the runs the server keeps.
export function TasksPage() {
  const session = useSession()
  const stats = useApi<{ tasks: TaskStats[] }>('/tasks')
  const [text, setText] = useState('')
  const now = useNow()
  return (
    <>
      <PageTitle
        note={`over the runs the server keeps (runs.keep)${
          session.data?.seesOthers ? ', of everybody' : ' that you may see'
        }`}
      >
        Tasks
      </PageTitle>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          className={`${inputClass} min-w-0 flex-1 sm:max-w-xs`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="task or repository"
          aria-label="Search"
        />
        <Quiet>
          <span className="text-xs">Median and 90% count the runs that executed the task, not the cached ones.</span>
        </Quiet>
      </div>
      <Loading query={stats}>
        {({ tasks }) => {
          const needle = text.trim().toLowerCase()
          const shown = tasks.filter((entry) => !needle || `${entry.repo} ${entry.task}`.toLowerCase().includes(needle))
          if (shown.length === 0) {
            return <Empty>No task ran in the runs the server keeps.</Empty>
          }
          return (
            <Table head={['Task', 'Repository', 'Last', 'Runs', 'Failed', 'Cached', 'Median', '90%', 'Waited']}>
              {shown.map((entry) => (
                <tr key={`${entry.repo}\0${entry.task}`}>
                  <Td>
                    <Code>{entry.task}</Code>
                  </Td>
                  <Td>
                    <T>{entry.repo}</T>
                  </Td>
                  <Td className="whitespace-nowrap">
                    <State state={entry.last.status} /> <Time iso={entry.last.at} now={now} />
                    {entry.last.durationMs !== undefined ? (
                      <div className="text-xs text-stone-500">took {span(entry.last.durationMs)}</div>
                    ) : null}
                  </Td>
                  <Td num>{entry.runs}</Td>
                  <Td num>{entry.failed || ''}</Td>
                  <Td num>{entry.cached || ''}</Td>
                  <Td num>{span(entry.medianMs)}</Td>
                  <Td num>{span(entry.p90Ms)}</Td>
                  <Td num>{span(entry.medianWaitMs)}</Td>
                </tr>
              ))}
            </Table>
          )
        }}
      </Loading>
    </>
  )
}
