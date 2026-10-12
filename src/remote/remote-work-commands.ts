import { Command, Option } from 'commander'
import colors from 'colors'
import { Environment } from '../executer/environment'
import { getAccessToken } from './credentials'
import { HostServer } from './host-config'
import { collectBundle } from './collect-bundle'
import { Bundle, HASH_PATTERN } from './bundle'
import { callServer, printable } from './server-client'
import { showBundle } from './bundle-text'

export interface WorkCommandContext {
  environment: Environment
  // the build file of the working directory, or the one `--file` named
  buildFile: string
  getServer: (name: string | undefined) => Promise<{ name: string; server: HostServer }>
  guarded: (failure: string, fn: (...args: any[]) => Promise<void>) => (...args: any[]) => Promise<void>
}

interface PublishedVersion {
  hash: string
  created: boolean
  tasks: string[]
  services: string[]
  // set when the version is only proposed
  state?: string
  expiresAt?: string
}

interface ProposalView {
  hash: string
  state: string
  proposedBy: { iss: string; sub: string }
  createdAt: string
  expiresAt: string
  decidedBy?: { sub: string }
  reason?: string
  tasks: string[]
  services: string[]
  accounts: string[]
  missing: string[]
  plan?: Record<string, PlanView>
  mine: boolean
  canDecide: boolean
}

interface ApprovalView {
  id: string
  requestedBy: { iss: string; sub: string }
  createdAt: string
  // the hash of the published version it runs
  definition: string
  tasks: string[]
  accounts: string[]
  source: { type: string; ref?: string; snapshot?: string }
  options: Record<string, unknown>
  approvals?: { account: string; expiresAt: string; approvedBy?: { sub: string } }[]
  plan?: Record<string, PlanView>
  state: string
}

// what a task or service does, see the plan of a version on the server
interface PlanView {
  kind: 'task' | 'service'
  runtime: string
  image?: string
  cmds: string[]
  deps: string[]
  needs: string[]
  accounts: string[]
  secrets: { from: string; account: string | null; target: string }[]
  mounts: string[]
  ports: string[]
  generates: string[]
  flags: string[]
}

const RUN_ID = /^run_[A-Za-z0-9_-]{16}$/

// What a person who approves is shown of a run: everything the decision rests on.
function describe(run: ApprovalView): string[] {
  const source = run.source.type === 'ref' ? `ref ${run.source.ref}` : `snapshot ${run.source.snapshot}`
  const options = Object.entries(run.options)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : value}`)
    .join(' ')
  return [
    `${colors.bold(printable(run.id))}  requested by ${printable(run.requestedBy.sub)} (${printable(
      run.requestedBy.iss
    )})`,
    `  build file ${printable(run.definition)}`,
    `  tasks: ${run.tasks.length > 0 ? run.tasks.map(printable).join(', ') : 'selected by labels'}`,
    `  accounts: ${run.accounts.length > 0 ? run.accounts.map(printable).join(', ') : 'none'}, source ${printable(
      source
    )}${options ? `, ${printable(options)}` : ''}`,
    ...(run.approvals ?? []).map(
      (approval) =>
        `  ${printable(approval.account)}: ${
          approval.approvedBy
            ? `approved by ${printable(approval.approvedBy.sub)}`
            : 'waits for somebody who uses it to approve'
        }`
    ),
    ...flagLines(run),
    `  decide before ${printable(run.approvals?.[0]?.expiresAt ?? '-')}`,
  ]
}

// What to look at first, one line.
function flagLines(run: { plan?: Record<string, PlanView> }): string[] {
  const flagged = Object.entries(run.plan ?? {}).filter(([, entry]) => entry.flags.length > 0)
  return flagged.length > 0
    ? [
        `  look at: ${flagged
          .map(([name, entry]) => `${printable(name)} (${entry.flags.map(printable).join(', ')})`)
          .join(', ')}`,
      ]
    : []
}

// The tasks and services the run executes and what each does, never a secret's value.
function describePlan(plan: Record<string, PlanView>): string[] {
  return Object.entries(plan).flatMap(([name, entry]) => [
    `  ${colors.bold(printable(name))}  ${entry.kind}, ${printable(entry.runtime)}${
      entry.image ? ` ${printable(entry.image)}` : ''
    }${entry.flags.length > 0 ? `  [${entry.flags.map(printable).join(', ')}]` : ''}`,
    ...entry.cmds.map((cmd) => `    $ ${printable(cmd)}`),
    ...(entry.deps.length > 0 ? [`    after: ${entry.deps.map(printable).join(', ')}`] : []),
    ...(entry.needs.length > 0 ? [`    needs: ${entry.needs.map(printable).join(', ')}`] : []),
    ...entry.secrets.map(
      (secret) =>
        `    secret ${printable(secret.from)}${secret.account ? ` as ${printable(secret.account)}` : ''} -> ${printable(
          secret.target
        )}`
    ),
    ...(entry.mounts.length > 0 ? [`    mounts: ${entry.mounts.map(printable).join(', ')}`] : []),
    ...(entry.ports.length > 0 ? [`    ports: ${entry.ports.map(printable).join(', ')}`] : []),
    ...(entry.generates.length > 0 ? [`    generates: ${entry.generates.map(printable).join(', ')}`] : []),
  ])
}

export function registerWorkCommands(remote: Command, context: WorkCommandContext): void {
  const { environment, buildFile, getServer, guarded } = context

  const connect = async (name: string | undefined) => {
    const chosen = await getServer(name)
    const token = await getAccessToken(environment, chosen.name, chosen.server)
    return { ...chosen, token }
  }

  remote
    .command('publish [server]')
    .description('publish the build file and the files it includes to a server, runs refer to it by its hash')
    .action(
      guarded('Remote publish was not successful', async (name: string | undefined) => {
        const bundle = await collectBundle(buildFile, environment)
        const { name: serverName, server, token } = await connect(name)
        const answer = await callServer<PublishedVersion>(server, token, 'POST', '/v1/definitions', bundle)
        const version = answer.body
        const files = Object.keys(bundle.files).length
        const proposed = answer.status === 202
        const verb = proposed ? 'proposed' : answer.status === 201 ? 'published' : 'already published'
        environment.stdout.write(
          `${verb} to ${serverName}: ${printable(version.hash)} (${files} ${files === 1 ? 'file' : 'files'})\n`
        )
        const names = [...(version.tasks ?? []), ...(version.services ?? [])]
        environment.stdout.write(`tasks and services: ${names.map(printable).join(', ') || 'none'}\n`)
        if (proposed) {
          environment.stdout.write(
            `it can not run before somebody who may publish approves it, until ${printable(version.expiresAt)}\n`
          )
        }
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

  remote
    .command('show <target> [server]')
    .description(
      'show a run (run_...) or a proposed version (sha256:...) in full: the commands, secrets and accounts of its tasks, and the files of a version'
    )
    .action(
      guarded('Remote show was not successful', async (target: string, name: string | undefined) => {
        if (!RUN_ID.test(target) && !HASH_PATTERN.test(target)) {
          throw new Error(
            `${printable(
              target
            )} is not a run id or a proposed version, list them with: hammerkit remote approvals or remote proposals`
          )
        }
        const { name: serverName, server, token } = await connect(name)
        if (HASH_PATTERN.test(target)) {
          const path = `/v1/proposals/${target}`
          const proposal = (await callServer<ProposalView>(server, token, 'GET', path)).body
          const files = (await callServer<Bundle>(server, token, 'GET', `${path}/files`)).body
          environment.stdout.write(
            `${colors.bold(printable(proposal.hash))} on ${serverName}, proposed by ${printable(
              proposal.proposedBy.sub
            )} (${printable(proposal.proposedBy.iss)}), ${printable(proposal.state)}\n`
          )
          for (const line of [...flagLines(proposal), ...describePlan(proposal.plan ?? {}), ...showBundle(files)]) {
            environment.stdout.write(`${line}\n`)
          }
          return
        }
        const view = (await callServer<ApprovalView>(server, token, 'GET', `/v1/approvals/${target}`)).body
        for (const line of describe(view)) {
          environment.stdout.write(`${line}\n`)
        }
        environment.stdout.write(
          view.plan ? `${describePlan(view.plan).join('\n')}\n` : 'the server did not record what its tasks do\n'
        )
      })
    )

  remote
    .command('proposals [server]')
    .description('list the proposed versions of build files you made or may approve')
    .action(
      guarded('Remote proposals was not successful', async (name: string | undefined) => {
        const { name: serverName, server, token } = await connect(name)
        const { body } = await callServer<{ proposals: ProposalView[] }>(server, token, 'GET', '/v1/proposals')
        if (body.proposals.length === 0) {
          environment.stdout.write(`${serverName}: no proposed versions\n`)
          return
        }
        environment.stdout.write(`${serverName}: ${body.proposals.length} proposed\n`)
        for (const proposal of body.proposals) {
          const who = proposal.mine ? 'you' : printable(proposal.proposedBy.sub)
          const state = proposal.canDecide ? colors.bold('waits for your approval') : printable(proposal.state)
          environment.stdout.write(`${colors.bold(printable(proposal.hash))}  proposed by ${who}, ${state}\n`)
          const names = [...proposal.tasks, ...proposal.services]
          environment.stdout.write(`  tasks and services: ${names.map(printable).join(', ') || 'none'}\n`)
          if (proposal.accounts.length > 0) {
            environment.stdout.write(
              `  accounts: ${proposal.accounts.map(printable).join(', ')}${
                proposal.missing.length > 0
                  ? `, the proposer does not use ${proposal.missing.map(printable).join(', ')}`
                  : ''
              }\n`
            )
          }
          for (const line of flagLines(proposal)) {
            environment.stdout.write(`${line}\n`)
          }
          if (proposal.state === 'waiting') {
            environment.stdout.write(`  decide before ${printable(proposal.expiresAt)}\n`)
          } else if (proposal.reason) {
            environment.stdout.write(`  ${printable(proposal.state)}: ${printable(proposal.reason)}\n`)
          }
        }
      })
    )

  for (const action of ['yank', 'unyank'] as const) {
    remote
      .command(`${action} <version> [server]`)
      .description(
        action === 'yank'
          ? 'pull a published version (sha256:...) back: no run starts from it'
          : 'let a yanked version (sha256:...) go on'
      )
      .addOption(new Option('--reason <text>', 'why, shown to whoever tries to run it').argParser((value) => value))
      .action(
        guarded(`Remote ${action} was not successful`, async (target: string, name: string | undefined, options) => {
          if (!HASH_PATTERN.test(target)) {
            throw new Error(`${printable(target)} is not a version, name it by its hash: sha256:...`)
          }
          const { name: serverName, server, token } = await connect(name)
          await callServer(
            server,
            token,
            'POST',
            `/v1/definitions/${target}/${action}`,
            options.reason ? { reason: options.reason } : undefined
          )
          environment.stdout.write(
            `${action === 'yank' ? 'yanked' : 'let go on'} ${printable(target)} on ${serverName}\n`
          )
        })
      )
  }

  for (const action of ['approve', 'reject'] as const) {
    remote
      .command(`${action} <target> [server]`)
      .description(
        action === 'approve'
          ? 'let a run (run_...) or a proposed version (sha256:...) that waits for your approval go ahead'
          : 'end a run (run_...) or drop a proposed version (sha256:...) that waits for your approval'
      )
      .addOption(new Option('--reason <text>', 'why, shown to who asked').argParser((value) => value))
      .action(
        guarded(`Remote ${action} was not successful`, async (target: string, name: string | undefined, options) => {
          const proposal = HASH_PATTERN.test(target)
          if (!proposal && !RUN_ID.test(target)) {
            throw new Error(
              `${printable(
                target
              )} is not a run id or a proposed version, list them with: hammerkit remote approvals or remote proposals`
            )
          }
          const { name: serverName, server, token } = await connect(name)
          const path = proposal ? `/v1/proposals/${target}/${action}` : `/v1/approvals/${target}/${action}`
          const { body } = await callServer<{ state: string }>(
            server,
            token,
            'POST',
            path,
            options.reason ? { reason: options.reason } : undefined
          )
          const rejected = body.state === 'rejected'
          environment.stdout.write(
            proposal
              ? rejected
                ? `rejected ${target} on ${serverName}\n`
                : `approved ${target} on ${serverName}, it is published\n`
              : rejected
                ? `rejected ${target} on ${serverName}\n`
                : `approved ${target} on ${serverName}, it is queued\n`
          )
        })
      )
  }
}
