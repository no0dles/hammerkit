import { Command, Option } from 'commander'
import colors from 'colors'
import { Environment } from '../executer/environment'
import { getTokenSource } from './token-source'
import { HostServer } from './host-config'
import { collectBundle } from './collect-bundle'
import { Annotations, Bundle, hashBundle, HASH_PATTERN } from './bundle'
import { applyAnnotations, collectAnnotations, readCheckout } from './annotations'
import { callServer, printable, printableWhole, ServerError } from './server-client'
import { showBundle } from './bundle-text'
import { followRun, ServerConnection, submitRun } from '../harness/sandbox-client'
import { formatDuration } from '../utils/units'
import type { Run } from '../server/runs'
import { parseEndpoint } from '../harness/service-tools'
import { dirname } from 'path'

export interface WorkCommandContext {
  environment: Environment
  // the build file of the working directory, or the one `--file` named
  buildFile: string
  getServer: (name: string | undefined) => Promise<{ name: string; server: HostServer }>
  guarded: (failure: string, fn: (...args: any[]) => Promise<void>) => (...args: any[]) => Promise<void>
  // what follows `--` on the command line
  passthrough: string[]
  // ends the command with this exit code, saying why
  fail: (message: string, exitCode: number) => never
}

interface PublishedVersion {
  hash: string
  annotations?: Annotations
  created: boolean
  tasks: string[]
  services: string[]
  // set when the version is only proposed
  state?: string
  expiresAt?: string
}

// one version in the list of a server
interface VersionView {
  hash: string
  publishedAt: string
  publishedBy: { iss: string; sub: string }
  approvedBy?: { sub: string }
  annotations: Annotations
  tasks: string[]
  services: string[]
  accounts: string[]
  yanked?: { by: { sub: string }; reason?: string }
}

// a published version whole, as `GET /v1/definitions/<hash>` answers it
interface PublishedView extends Omit<VersionView, 'annotations' | 'accounts'> {
  annotations?: Annotations
  accounts?: string[]
  plan?: Record<string, PlanView>
}

interface ProposalView {
  hash: string
  annotations?: Annotations
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

export interface ApprovalView {
  id: string
  requestedBy: { iss: string; sub: string }
  createdAt: string
  // the hash of the published version it runs
  definition: string
  tasks: string[]
  accounts: string[]
  source: {
    type: string
    ref?: string
    snapshot?: string
    repo?: string
    commit?: string
    tree?: string
    clean?: boolean
  }
  options: Record<string, unknown>
  approvals?: { account: string; expiresAt: string; approvedBy?: { sub: string } }[]
  plan?: Record<string, PlanView>
  state: string
}

// what a task or service does, see the plan of a version on the server
export interface PlanView {
  kind: 'task' | 'service'
  runtime: string
  image?: string
  cmds: string[]
  network?: unknown
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

// what the publisher said about where a version comes from, one line
// What a publisher said about where a version comes from: the server takes it as said,
// so anybody else is told it is not checked.
function annotationLines(annotations: Annotations | undefined, label = 'from (unverified)'): string[] {
  const entries = Object.entries(annotations ?? {})
  return entries.length > 0
    ? [`  ${label}: ${entries.map(([key, value]) => `${printable(key)}=${printable(value)}`).join(' ')}`]
    : []
}

function yankLines(version: { yanked?: { by: { sub: string }; reason?: string } }): string[] {
  return version.yanked
    ? [
        `  yanked by ${printable(version.yanked.by.sub)}${
          version.yanked.reason ? `: ${printable(version.yanked.reason)}` : ''
        }`,
      ]
    : []
}

// A line a task printed, shown as it is but for control characters, so it can't rewrite
// the terminal; tabs stay.
function printableLine(text: string): string {
  return text.split('\t').map(printableWhole).join('\t')
}

const collectOption = (value: string, previous: string[] = []) => [...previous, value]

// What a person who approves is shown of a run: everything the decision rests on.
export function describeApproval(run: ApprovalView): string[] {
  const source =
    run.source.type === 'ref'
      ? `ref ${run.source.ref}`
      : run.source.type === 'sandbox'
        ? `sandbox of ${run.source.repo} at ${run.source.commit}, ${
            run.source.clean ? 'unchanged' : `with changes, files ${run.source.tree}`
          } (files .gitignore leaves out are not shown)`
        : `snapshot ${run.source.snapshot}`
  // the arguments are shown whole on a line of their own, each as a JSON string,
  // so commas, spaces and quotes inside one stay visible
  const { args, ...settings } = run.options
  const options = Object.entries(settings)
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
    ...(Array.isArray(args) && args.length > 0
      ? [`  arguments: ${args.map((arg) => printableWhole(JSON.stringify(arg))).join(' ')}`]
      : []),
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
export function describePlan(plan: Record<string, PlanView>): string[] {
  return Object.entries(plan).flatMap(([name, entry]) => [
    `  ${colors.bold(printable(name))}  ${entry.kind}, ${printable(entry.runtime)}${
      entry.image ? ` ${printable(entry.image)}` : ''
    }${entry.flags.length > 0 ? `  [${entry.flags.map(printable).join(', ')}]` : ''}`,
    // a command is what is decided on: shown whole, however long
    ...entry.cmds.map((cmd) => `    $ ${printableWhole(cmd)}`),
    ...(entry.network !== undefined && entry.network !== 'open'
      ? [`    network: ${printable(typeof entry.network === 'string' ? entry.network : JSON.stringify(entry.network))}`]
      : []),
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
  const { environment, buildFile, getServer, guarded, passthrough, fail } = context

  // the ref a run starts from: what the options name, else the checkout here
  const refSource = async (options: {
    repo?: string
    ref?: string
    commit?: string
  }): Promise<{ type: 'ref'; repo: string; ref: string; commit?: string }> => {
    const checkout = options.repo && options.ref ? {} : await readCheckout(dirname(buildFile))
    const repo: string | undefined = options.repo ?? checkout.repo
    const ref: string | undefined = options.ref ?? checkout.branch
    // the commit checked out here is the code meant, when the ref is the branch it is on
    const commit: string | undefined = options.commit ?? (options.ref ? undefined : checkout.commit)
    if (!repo) {
      throw new Error('name the repository with --repo, the checkout here has no origin it can be told by')
    }
    if (!ref) {
      throw new Error('name the branch or tag with --ref, the checkout here is on no branch')
    }
    return { type: 'ref', repo, ref, ...(commit ? { commit } : {}) }
  }

  const connect = async (name: string | undefined) => {
    const chosen = await getServer(name)
    // a CI job or an agent brings its own token, a person signs in
    const token = await getTokenSource(environment, chosen.name, chosen.server).token()
    return { ...chosen, token }
  }

  remote
    .command('publish [server]')
    .description('publish the build file and the files it includes to a server, runs refer to it by its hash')
    .addOption(
      new Option(
        '--annotation <key=value>',
        'say more about where it comes from, or leave one out with key=; path, repo, commit, machine and user are filled in'
      ).argParser(collectOption)
    )
    .action(
      guarded('Remote publish was not successful', async (name: string | undefined, options) => {
        const bundle = await collectBundle(buildFile, environment)
        const annotations = applyAnnotations(
          await collectAnnotations(buildFile, Object.keys(bundle.files)),
          options.annotation ?? []
        )
        const { name: serverName, server, token } = await connect(name)
        const answer = await callServer<PublishedVersion>(server, token, 'POST', '/v1/definitions', {
          ...bundle,
          annotations,
        })
        const version = answer.body
        const files = Object.keys(bundle.files).length
        const proposed = answer.status === 202
        const verb = proposed ? 'proposed' : answer.status === 201 ? 'published' : 'already published'
        environment.stdout.write(
          `${verb} to ${serverName}: ${printable(version.hash)} (${files} ${files === 1 ? 'file' : 'files'})\n`
        )
        const names = [...(version.tasks ?? []), ...(version.services ?? [])]
        environment.stdout.write(`tasks and services: ${names.map(printable).join(', ') || 'none'}\n`)
        for (const line of annotationLines(version.annotations, 'from')) {
          environment.stdout.write(`${line.trimStart()}\n`)
        }
        if (proposed) {
          environment.stdout.write(
            `it can not run before somebody who may publish approves it, until ${printable(version.expiresAt)}\n`
          )
        }
      })
    )

  remote
    .command('run <tasks...>')
    .description(
      'run tasks of a published build file on a server from a git ref, print their output and exit as they did'
    )
    .addOption(new Option('--server <name>', 'the server to run on; the default of remote use when left out'))
    .addOption(
      new Option(
        '--build <hash>',
        'the published version to run (sha256:...), or HAMMERKIT_BUILD; the hash of the build file here when left out'
      )
    )
    .addOption(
      new Option(
        '--repo <host/path>',
        'the repository, such as github.com/corp/payments; origin of the checkout here when left out'
      )
    )
    .addOption(new Option('--ref <ref>', 'the branch or tag to run; the branch checked out here when left out'))
    .addOption(
      new Option(
        '--commit <sha>',
        'the commit the ref has to be at, else the run is refused; the commit checked out here when --ref is left out'
      )
    )
    .addOption(new Option('--env <name>', 'the environment of the build file, as --env of run'))
    .addOption(new Option('--cache <method>', 'as --cache of run').choices(['checksum', 'modify-date', 'none']))
    .addOption(new Option('--timeout <duration>', 'as --timeout of run: for tasks without their own, such as 30m'))
    .addOption(
      new Option('--max-timeout <duration>', 'as --max-timeout of run: for every task, also one with its own timeout')
    )
    .action(
      guarded('Remote run was not successful', async (tasks: string[], options) => {
        const named: string | undefined = options.build ?? environment.processEnvs.HAMMERKIT_BUILD
        const definition = named ?? hashBundle(await collectBundle(buildFile, environment))
        if (!HASH_PATTERN.test(definition)) {
          throw new Error(`${printable(definition)} is not the hash of a published version (sha256:...)`)
        }
        const source = await refSource(options)
        const ref = source.ref
        const { name: serverName, server } = await getServer(options.server)
        const connection: ServerConnection = { url: server.url, ...getTokenSource(environment, serverName, server) }
        const runOptions: { [key: string]: unknown } = {}
        for (const key of ['env', 'cache', 'timeout', 'maxTimeout']) {
          if (options[key] !== undefined) {
            runOptions[key] = options[key]
          }
        }
        if (passthrough.length > 0) {
          runOptions.args = passthrough
        }
        let submitted: Run
        try {
          submitted = await submitRun(connection, {
            definition,
            tasks,
            source,
            options: runOptions,
          })
        } catch (e) {
          if ((e as { status?: number }).status === 400 && !named && /no published build file/.test(String(e))) {
            throw new Error(`the build file here is not published on ${serverName} (${definition}), publish it first`)
          }
          throw e
        }
        const at = submitted.source.type === 'ref' ? ` at ${printable(submitted.source.commit)}` : ''
        environment.stdout.write(
          `${printable(submitted.id)} on ${serverName}: ${tasks.map(printable).join(', ')} from ${printable(
            ref
          )}${at}\n`
        )
        const prefixed = tasks.length > 1
        const followed = await followRun(connection, submitted, {
          signal: environment.abortCtrl.signal,
          onLine: (line) => {
            environment.stdout.write(
              `${prefixed || line.task !== tasks[0] ? `[${printable(line.task)}] ` : ''}${printableLine(line.text)}\n`
            )
          },
          onWaiting: (run) => {
            for (const approval of run.approvals ?? []) {
              environment.stdout.write(
                `waiting until somebody who uses ${printable(approval.account)} approves it, before ${printable(
                  approval.expiresAt
                )}: hammerkit remote approve ${printable(run.id)}\n`
              )
            }
          },
        })
        const run = followed.run
        if (run.state === 'succeeded') {
          environment.stdout.write(`${printable(run.id)} succeeded\n`)
          return
        }
        // the exit code of the first task that failed, as `hammerkit run` would end
        const failed = tasks
          .map((task) => run.results?.[task])
          .concat(Object.values(run.results ?? {}))
          .find((result) => result?.status === 'failed')
        const exitCode = failed?.exitCode && failed.exitCode > 0 ? failed.exitCode : 1
        fail(`${printable(run.id)} ${run.state}${run.error ? `: ${printable(run.error)}` : ''}`, exitCode)
      })
    )

  remote
    .command('up <services...>')
    .description(
      'start services of a published build file on a server from a git ref and keep them up until their ttl ends, ' +
        'with their endpoints at addresses of their own behind the sign-in of the server'
    )
    .addOption(new Option('--server <name>', 'the server to run on; the default of remote use when left out'))
    .addOption(
      new Option(
        '--endpoint <service:port>',
        'publish this port of a service, such as web:8080; may be given more than once'
      ).argParser(collectOption)
    )
    .addOption(
      new Option(
        '--ttl <duration>',
        'how long they stay once ready, such as 2h, then they are removed; the server default when left out'
      )
    )
    .addOption(
      new Option(
        '--sleep-ttl <duration>',
        'how long they stay up without a request, such as 30m, then they sleep until the next request wakes them; ' +
          'the server default when left out'
      )
    )
    .addOption(
      new Option(
        '--name <name>',
        'a later run of yours with the same name replaces this one and keeps its addresses; the branch when left out'
      )
    )
    .addOption(
      new Option(
        '--build <hash>',
        'the published version to run (sha256:...), or HAMMERKIT_BUILD; the hash of the build file here when left out'
      )
    )
    .addOption(new Option('--repo <host/path>', 'the repository; origin of the checkout here when left out'))
    .addOption(new Option('--ref <ref>', 'the branch or tag to start; the branch checked out here when left out'))
    .addOption(
      new Option(
        '--commit <sha>',
        'the commit the ref has to be at; the commit checked out here when --ref is left out'
      )
    )
    .addOption(new Option('--env <name>', 'the environment of the build file, as --env of run'))
    .action(
      guarded('Remote up was not successful', async (services: string[], options) => {
        const named: string | undefined = options.build ?? environment.processEnvs.HAMMERKIT_BUILD
        const definition = named ?? hashBundle(await collectBundle(buildFile, environment))
        if (!HASH_PATTERN.test(definition)) {
          throw new Error(`${printable(definition)} is not the hash of a published version (sha256:...)`)
        }
        const endpoints = ((options.endpoint ?? []) as string[]).map(parseEndpoint)
        const source = await refSource(options)
        const { name: serverName, server } = await getServer(options.server)
        const connection: ServerConnection = { url: server.url, ...getTokenSource(environment, serverName, server) }
        const submitted = await submitRun(connection, {
          definition,
          services,
          endpoints,
          ...(options.ttl ? { ttl: options.ttl } : {}),
          ...(options.sleepTtl ? { sleepTtl: options.sleepTtl } : {}),
          ...(options.name ? { name: options.name } : {}),
          source,
          options: options.env ? { env: options.env } : {},
        })
        environment.stdout.write(
          `${printable(submitted.id)} on ${serverName}: ${services.map(printable).join(', ')} from ${printable(
            source.ref
          )}${submitted.source.type === 'ref' ? ` at ${printable(submitted.source.commit)}` : ''}\n`
        )
        const followed = await followRun(connection, submitted, {
          signal: environment.abortCtrl.signal,
          untilUp: true,
          onLine: (line) => environment.stdout.write(`[${printable(line.task)}] ${printableLine(line.text)}\n`),
          onWaiting: (run) => {
            for (const approval of run.approvals ?? []) {
              environment.stdout.write(
                `waiting until somebody who uses ${printable(approval.account)} approves it, before ${printable(
                  approval.expiresAt
                )}: hammerkit remote approve ${printable(run.id)}\n`
              )
            }
          },
        })
        const run = followed.run
        if (run.state !== 'up') {
          fail(`${printable(run.id)} ${run.state}${run.error ? `: ${printable(run.error)}` : ''}`, 1)
        }
        environment.stdout.write(
          `${printable(run.id)} is up until ${printable(run.expiresAt ?? '-')}${
            run.up?.sleepTtl ? `, asleep after ${formatDuration(run.up.sleepTtl)} without a request` : ''
          }\n`
        )
        for (const endpoint of run.up?.endpoints ?? []) {
          environment.stdout.write(`  ${printable(endpoint.service)}:${endpoint.port}  ${printable(endpoint.url)}\n`)
        }
        environment.stdout.write(
          `extend it with: hammerkit remote extend ${printable(
            run.id
          )} 8h, stop it with: hammerkit remote stop ${printable(run.id)}\n`
        )
      })
    )

  remote
    .command('extend <run> <ttl> [server]')
    .description('keep a service run that is up for this long from now, such as 8h, at most the maxTtl of the server')
    .action(
      guarded('Remote extend was not successful', async (id: string, ttl: string, name: string | undefined) => {
        if (!RUN_ID.test(id)) {
          throw new Error(`${printable(id)} is not a run id (run_...)`)
        }
        const { name: serverName, server, token } = await connect(name)
        const run = (await callServer<Run>(server, token, 'POST', `/v1/runs/${id}/extend`, { ttl })).body
        environment.stdout.write(
          `${printable(run.id)} on ${serverName} stays up until ${printable(run.expiresAt ?? '-')}\n`
        )
      })
    )

  remote
    .command('stop <run> [server]')
    .description('stop a run: a service run takes its services and endpoints down')
    .action(
      guarded('Remote stop was not successful', async (id: string, name: string | undefined) => {
        if (!RUN_ID.test(id)) {
          throw new Error(`${printable(id)} is not a run id (run_...)`)
        }
        const { name: serverName, server, token } = await connect(name)
        const run = (await callServer<Run>(server, token, 'POST', `/v1/runs/${id}/cancel`)).body
        environment.stdout.write(
          `${printable(run.id)} on ${serverName}: ${
            run.state === 'up' || run.state === 'running' ? 'stopping' : printable(run.state)
          }\n`
        )
      })
    )

  remote
    .command('versions [server]')
    .description('list the published versions of build files on a server, newest first, with where they come from')
    .addOption(
      new Option(
        '--filter <key=value>',
        'only the versions with this annotation, such as repo=github.com/corp/payments'
      ).argParser(collectOption)
    )
    .action(
      guarded('Remote versions was not successful', async (name: string | undefined, options) => {
        const query = new URLSearchParams()
        for (const filter of (options.filter ?? []) as string[]) {
          const index = filter.indexOf('=')
          if (index <= 0) {
            throw new Error(`${printable(filter)} is not a filter, write it as key=value`)
          }
          if (index === filter.length - 1) {
            throw new Error(`${printable(filter)} matches nothing, an annotation always has a value`)
          }
          query.append(filter.slice(0, index), filter.slice(index + 1))
        }
        const { name: serverName, server, token } = await connect(name)
        const path = `/v1/definitions${query.toString() !== '' ? `?${query}` : ''}`
        const { body } = await callServer<{ definitions: VersionView[] }>(server, token, 'GET', path)
        if (body.definitions.length === 0) {
          environment.stdout.write(`${serverName}: no published versions${query.toString() !== '' ? ' match' : ''}\n`)
          return
        }
        environment.stdout.write(`${serverName}: ${body.definitions.length} published\n`)
        for (const version of body.definitions) {
          environment.stdout.write(
            `${colors.bold(printable(version.hash))}  published by ${printable(version.publishedBy.sub)} at ${printable(
              version.publishedAt
            )}${version.approvedBy ? `, approved by ${printable(version.approvedBy.sub)}` : ''}\n`
          )
          for (const line of annotationLines(version.annotations)) {
            environment.stdout.write(`${line}\n`)
          }
          const names = [...version.tasks, ...version.services]
          environment.stdout.write(`  tasks and services: ${names.map(printable).join(', ') || 'none'}\n`)
          if (version.accounts.length > 0) {
            environment.stdout.write(`  accounts: ${version.accounts.map(printable).join(', ')}\n`)
          }
          for (const line of yankLines(version)) {
            environment.stdout.write(`${line}\n`)
          }
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
          for (const line of describeApproval(run)) {
            environment.stdout.write(`${line}\n`)
          }
        }
      })
    )

  // A version that is published: who published it, what its tasks do and every file.
  const showPublished = async (hash: string, serverName: string, server: HostServer, token: string) => {
    const path = `/v1/definitions/${hash}`
    let version: PublishedView
    try {
      version = (await callServer<PublishedView>(server, token, 'GET', path)).body
    } catch (e) {
      if (e instanceof ServerError && e.status === 404) {
        throw new Error(`${serverName} has no proposal or published version ${printable(hash)} you may see`)
      }
      throw e
    }
    const files = (await callServer<Bundle>(server, token, 'GET', `${path}/files`)).body
    environment.stdout.write(
      `${colors.bold(printable(version.hash))} on ${serverName}, published by ${printable(
        version.publishedBy.sub
      )} (${printable(version.publishedBy.iss)}) at ${printable(version.publishedAt)}${
        version.approvedBy ? `, approved by ${printable(version.approvedBy.sub)}` : ''
      }\n`
    )
    for (const line of [
      ...yankLines(version),
      ...annotationLines(version.annotations),
      ...flagLines(version),
      ...(version.plan ? describePlan(version.plan) : ['  the server did not record what its tasks do']),
      ...showBundle(files),
    ]) {
      environment.stdout.write(`${line}\n`)
    }
  }

  remote
    .command('show <target> [server]')
    .description(
      'show a run (run_...) or a proposed or published version (sha256:...) in full: the commands, secrets and accounts of its tasks, and the files of a version'
    )
    .action(
      guarded('Remote show was not successful', async (target: string, name: string | undefined) => {
        if (!RUN_ID.test(target) && !HASH_PATTERN.test(target)) {
          throw new Error(
            `${printable(
              target
            )} is not a run id or a version, list them with: hammerkit remote approvals, remote proposals or remote versions`
          )
        }
        const { name: serverName, server, token } = await connect(name)
        if (HASH_PATTERN.test(target)) {
          const path = `/v1/proposals/${target}`
          let proposal: ProposalView
          try {
            proposal = (await callServer<ProposalView>(server, token, 'GET', path)).body
          } catch (e) {
            if (e instanceof ServerError && e.status === 404) {
              await showPublished(target, serverName, server, token)
              return
            }
            throw e
          }
          if (proposal.state === 'approved') {
            await showPublished(target, serverName, server, token)
            return
          }
          if (proposal.state !== 'waiting') {
            // a decided proposal keeps no files
            environment.stdout.write(
              `${colors.bold(printable(proposal.hash))} on ${serverName}, proposed by ${printable(
                proposal.proposedBy.sub
              )}, ${printable(proposal.state)}${proposal.decidedBy ? ` by ${printable(proposal.decidedBy.sub)}` : ''}${
                proposal.reason ? `: ${printable(proposal.reason)}` : ''
              }\n`
            )
            for (const line of annotationLines(proposal.annotations)) {
              environment.stdout.write(`${line}\n`)
            }
            environment.stdout.write('  its files are not kept once it is decided\n')
            return
          }
          const files = (await callServer<Bundle>(server, token, 'GET', `${path}/files`)).body
          environment.stdout.write(
            `${colors.bold(printable(proposal.hash))} on ${serverName}, proposed by ${printable(
              proposal.proposedBy.sub
            )} (${printable(proposal.proposedBy.iss)}), ${printable(proposal.state)}\n`
          )
          for (const line of [
            ...annotationLines(proposal.annotations),
            ...flagLines(proposal),
            ...describePlan(proposal.plan ?? {}),
            ...showBundle(files),
          ]) {
            environment.stdout.write(`${line}\n`)
          }
          return
        }
        const view = (await callServer<ApprovalView>(server, token, 'GET', `/v1/approvals/${target}`)).body
        for (const line of describeApproval(view)) {
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
          for (const line of annotationLines(proposal.annotations)) {
            environment.stdout.write(`${line}\n`)
          }
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
