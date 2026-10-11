import { Command, Option } from 'commander'
import colors from 'colors'
import { Environment } from '../executer/environment'
import { getAccessToken } from './credentials'
import { HostServer } from './host-config'
import { collectBundle } from './collect-bundle'
import { callServer, printable } from './server-client'

export interface WorkCommandContext {
  environment: Environment
  // the build file of the working directory, or the one `--file` named
  buildFile: string
  getServer: (name: string | undefined) => Promise<{ name: string; server: HostServer }>
  guarded: (failure: string, fn: (...args: any[]) => Promise<void>) => (...args: any[]) => Promise<void>
}

interface PublishedVersion {
  name: string
  hash: string
  created: boolean
  tasks: string[]
  services: string[]
}

interface ApprovalView {
  id: string
  requestedBy: { iss: string; sub: string }
  createdAt: string
  definition: { name: string; hash: string }
  tasks: string[]
  account: string | null
  source: { type: string; ref?: string; snapshot?: string }
  options: Record<string, unknown>
  approval?: { rules: { name: string; approvedBy?: { sub: string } }[]; expiresAt: string }
  state: string
}

const RUN_ID = /^run_[A-Za-z0-9_-]{16}$/

// What a person who approves is shown of a run: everything the decision rests on.
function describe(run: ApprovalView): string[] {
  const source = run.source.type === 'ref' ? `ref ${run.source.ref}` : `snapshot ${run.source.snapshot}`
  const options = Object.entries(run.options)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : value}`)
    .join(' ')
  const pending = (run.approval?.rules ?? []).filter((rule) => !rule.approvedBy).map((rule) => rule.name)
  const done = (run.approval?.rules ?? []).filter((rule) => rule.approvedBy)
  return [
    `${colors.bold(printable(run.id))}  requested by ${printable(run.requestedBy.sub)} (${printable(
      run.requestedBy.iss
    )})`,
    `  ${printable(run.definition.name)} ${printable(run.definition.hash)}`,
    `  tasks: ${run.tasks.length > 0 ? run.tasks.map(printable).join(', ') : 'selected by labels'}`,
    `  account ${run.account === null ? 'none' : printable(run.account)}, source ${printable(source)}${
      options ? `, ${printable(options)}` : ''
    }`,
    `  needs approval for: ${pending.map(printable).join(', ') || '-'}${
      done.length > 0
        ? ` (approved: ${done.map((d) => `${printable(d.name)} by ${printable(d.approvedBy?.sub)}`).join(', ')})`
        : ''
    }`,
    `  decide before ${printable(run.approval?.expiresAt ?? '-')}`,
  ]
}

export function registerWorkCommands(remote: Command, context: WorkCommandContext): void {
  const { environment, buildFile, getServer, guarded } = context

  const connect = async (name: string | undefined) => {
    const chosen = await getServer(name)
    const token = await getAccessToken(environment, chosen.name, chosen.server)
    return { ...chosen, token }
  }

  remote
    .command('publish <definition> [server]')
    .description('publish the build file and the files it includes to a server, under a name runs can refer to')
    .action(
      guarded('Remote publish was not successful', async (definition: string, name: string | undefined) => {
        const bundle = await collectBundle(buildFile, environment)
        const { name: serverName, server, token } = await connect(name)
        const answer = await callServer<PublishedVersion>(
          server,
          token,
          'PUT',
          `/v1/definitions/${encodeURIComponent(definition)}`,
          bundle
        )
        const version = answer.body
        const files = Object.keys(bundle.files).length
        environment.stdout.write(
          `${answer.status === 201 ? 'published' : 'already published'} ${definition} to ${serverName}: ${printable(
            version.hash
          )} (${files} ${files === 1 ? 'file' : 'files'})\n`
        )
        const names = [...(version.tasks ?? []), ...(version.services ?? [])]
        environment.stdout.write(`tasks and services: ${names.map(printable).join(', ') || 'none'}\n`)
      })
    )

  remote
    .command('approvals [server]')
    .description('list the runs on a server that wait for your approval')
    .action(
      guarded('Remote approvals was not successful', async (name: string | undefined) => {
        const { name: serverName, server, token } = await connect(name)
        const { body } = await callServer<{ approvals: ApprovalView[] }>(server, token, 'GET', '/v1/approvals')
        if (body.approvals.length === 0) {
          environment.stdout.write(`${serverName}: no runs wait for your approval\n`)
          return
        }
        environment.stdout.write(`${serverName}: ${body.approvals.length} waiting for your approval\n`)
        for (const run of body.approvals) {
          for (const line of describe(run)) {
            environment.stdout.write(`${line}\n`)
          }
        }
      })
    )

  for (const action of ['approve', 'reject'] as const) {
    remote
      .command(`${action} <run> [server]`)
      .description(
        action === 'approve'
          ? 'let a run that waits for your approval go ahead'
          : 'end a run that waits for your approval'
      )
      .addOption(new Option('--reason <text>', 'why, shown to who asked for the run').argParser((value) => value))
      .action(
        guarded(`Remote ${action} was not successful`, async (run: string, name: string | undefined, options) => {
          if (!RUN_ID.test(run)) {
            throw new Error(`${printable(run)} is not a run id, list them with: hammerkit remote approvals`)
          }
          const { name: serverName, server, token } = await connect(name)
          const { body } = await callServer<ApprovalView>(
            server,
            token,
            'POST',
            `/v1/approvals/${run}/${action}`,
            options.reason ? { reason: options.reason } : undefined
          )
          environment.stdout.write(
            body.state === 'rejected'
              ? `rejected ${run} on ${serverName}\n`
              : body.state === 'awaiting-approval'
                ? `approved ${run} on ${serverName} for your rules, it waits for the others\n`
                : `approved ${run} on ${serverName}, it is queued\n`
          )
        })
      )
  }
}
