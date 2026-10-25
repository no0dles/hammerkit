import { execFileSync } from 'child_process'
import { Command } from 'commander'
import { PassThrough } from 'stream'
import { addServer } from '../remote/host-config'
import { itExceptWindows, SANDBOX_REPO, withSandboxServer } from '../testing/sandbox-server'
import { connectSandbox, harnessOptionsFromEnv } from './connect'
import { createMcpTools, McpTool, serveMcp } from './mcp'
import { SandboxClient } from './sandbox-client'
import { registerMcpCommand } from './mcp-command'

// A client on the other end of the pipes: one request at a time, the answer by its id.
function connect(start: (input: PassThrough, output: PassThrough) => Promise<void>) {
  const input = new PassThrough()
  const output = new PassThrough()
  const answers = new Map<number, (message: any) => void>()
  let buffered = ''
  output.on('data', (chunk) => {
    buffered += chunk.toString()
    let end: number
    while ((end = buffered.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffered.slice(0, end))
      buffered = buffered.slice(end + 1)
      answers.get(message.id)?.(message)
    }
  })
  const served = start(input, output)
  let next = 1
  const request = (method: string, params?: unknown) => {
    const id = next++
    return new Promise<any>((resolve) => {
      answers.set(id, resolve)
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }
  const call = async (name: string, args: unknown) => {
    const answer = await request('tools/call', { name, arguments: args })
    return { text: answer.result?.content?.[0]?.text as string, isError: answer.result?.isError === true }
  }
  const close = async () => {
    input.end()
    await served
  }
  return { input, request, call, close, answers }
}

describe('mcp server', () => {
  it('speaks the protocol: initialize, ping, tools, and errors a client can tell apart', async () => {
    const tools: McpTool[] = [
      {
        name: 'echo',
        description: 'echo',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        annotations: { readOnlyHint: true },
        call: async (args) => {
          if (args.text === 'fail') {
            throw new Error('it failed')
          }
          return args.text
        },
      },
    ]
    const client = connect((input, output) =>
      serveMcp(input, output, tools, { name: 'hammerkit', version: '1.0.0', instructions: 'use echo' })
    )
    const init = await client.request('initialize', { protocolVersion: '2025-03-26', capabilities: {} })
    expect(init.result).toEqual({
      protocolVersion: '2025-03-26',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'hammerkit', version: '1.0.0' },
      instructions: 'use echo',
    })
    expect((await client.request('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion).toBe(
      '2025-06-18'
    )
    client.input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
    expect((await client.request('ping')).result).toEqual({})
    expect((await client.request('tools/list')).result.tools).toEqual([
      {
        name: 'echo',
        description: 'echo',
        inputSchema: tools[0].inputSchema,
        annotations: { readOnlyHint: true },
      },
    ])
    expect(await client.call('echo', { text: 'hi' })).toEqual({ text: 'hi', isError: false })
    expect(await client.call('echo', { text: 'fail' })).toEqual({ text: 'it failed', isError: true })
    expect(await client.call('echo', {})).toEqual({ text: 'missing text', isError: true })
    expect((await client.request('tools/call', { name: 'nope' })).error).toEqual({
      code: -32602,
      message: 'unknown tool nope',
    })
    expect((await client.request('resources/list')).error.code).toBe(-32601)

    const parse = new Promise<any>((resolve) => client.answers.set(null as never, resolve))
    client.input.write('not json\n')
    expect((await parse).error).toEqual({ code: -32700, message: 'parse error' })
    await client.close()
  })

  it('cancels a call the client gives up on', async () => {
    let seen: AbortSignal | undefined
    const tools: McpTool[] = [
      {
        name: 'wait',
        description: 'wait',
        inputSchema: { type: 'object', properties: {} },
        annotations: {},
        call: (_args, signal) =>
          new Promise((resolve) => {
            seen = signal
            signal.addEventListener('abort', () => resolve('stopped'))
          }),
      },
    ]
    const client = connect((input, output) => serveMcp(input, output, tools, { name: 'hammerkit', version: '1' }))
    void client.request('tools/call', { name: 'wait', arguments: {} })
    await new Promise((resolve) => setTimeout(resolve, 20))
    client.input.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } })}\n`
    )
    await client.close()
    expect(seen?.aborted).toBe(true)
  })
})

describe('mcp framing', () => {
  it('reads messages however the lines arrive, and answers requests only', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const answers: any[] = []
    let buffered = ''
    output.on('data', (chunk) => {
      buffered += chunk.toString()
      let end: number
      while ((end = buffered.indexOf('\n')) >= 0) {
        answers.push(JSON.parse(buffered.slice(0, end)))
        buffered = buffered.slice(end + 1)
      }
    })
    const echo: McpTool = {
      name: 'echo',
      description: 'echo',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      annotations: {},
      call: async (args) => args.text,
    }
    const served = serveMcp(input, output, [echo], { name: 't', version: '1' })
    const big = 'x'.repeat(1_000_000)
    // two messages in one chunk, one split across chunks and ended with CRLF
    input.write(
      '{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n{"jsonrpc":"2.0","id":3,'
    )
    input.write('"method":"ping"}\r\n')
    // a notification and an answer of the client get no answer
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
    input.write('{"jsonrpc":"2.0","id":9,"result":{}}\n')
    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'tools/call',
        params: { name: 'echo', arguments: { text: big } },
      })}\n`
    )
    input.write('{"jsonrpc":"2.0","id":"s","method":"ping"}\n')
    input.end()
    await served
    expect(answers.map((answer) => answer.id).sort()).toEqual([0, 1, 2, 3, 's'])
    expect(answers.every((answer) => answer.error === undefined)).toBe(true)
    expect(answers.find((answer) => answer.id === 0).result.content[0].text).toBe(big)
  })
})

describe('mcp tools on a sandbox', () => {
  it('reads, edits, searches and shows the changes of a sandbox', async () => {
    await withSandboxServer('harness-mcp-files', async ({ client: sandbox, repository }) => {
      const client = connect((input, output) =>
        serveMcp(
          input,
          output,
          createMcpTools(async () => sandbox),
          { name: 'hammerkit', version: '1' }
        )
      )
      const listed = (await client.request('tools/list')).result.tools
      expect(listed.map((tool: McpTool) => tool.name)).toEqual([
        'read',
        'write',
        'edit',
        'apply_patch',
        'search',
        'glob',
        'bash',
        'run_task',
        'run_logs',
        'changes',
        'push',
        'services_up',
        'endpoint_get',
        'services_stop',
      ])
      expect(listed.find((tool: McpTool) => tool.name === 'read').annotations).toMatchObject({
        readOnlyHint: true,
        openWorldHint: false,
      })
      expect(listed.find((tool: McpTool) => tool.name === 'edit').annotations).toMatchObject({ destructiveHint: true })

      expect((await client.call('read', { path: '/src/app.ts', offset: 2 })).text).toBe(
        '     2\texport const answer = 41\n\n(end of file, 2 lines)'
      )
      expect(await client.call('edit', { path: 'src/app.ts', old_string: '41', new_string: '42' })).toEqual({
        text: 'modified src/app.ts',
        isError: false,
      })
      const missing = await client.call('edit', { path: 'src/app.ts', old_string: '41', new_string: '43' })
      expect(missing.isError).toBe(true)
      expect(missing.text).toMatch(/old_string is not in src\/app\.ts/)
      expect(
        (
          await client.call('apply_patch', {
            patch: '*** Begin Patch\n*** Update File: input.txt\n@@\n-from-main\n+from-agent\n*** End Patch\n',
          })
        ).text
      ).toBe('modified input.txt')
      expect((await client.call('write', { path: 'docs/a.md', content: '# A\n' })).text).toBe(
        'added docs/a.md (4 bytes)'
      )
      expect((await client.call('search', { pattern: 'from-\\w+', output_mode: 'content' })).text).toBe(
        'input.txt:1: from-agent'
      )
      expect((await client.call('search', { pattern: 'nothing here' })).text).toBe('No matches found')
      expect((await client.call('glob', { pattern: '**/*.ts' })).text).toBe('src/app.ts')
      expect((await client.call('changes', {})).text).toBe(
        [
          `changes since ${sandbox.sandbox.commit}:`,
          'added docs/a.md +1 -0',
          'modified input.txt +1 -1',
          'modified src/app.ts +1 -1',
        ].join('\n')
      )
      expect((await client.call('changes', { format: 'diff' })).text).toContain('+from-agent')

      // the work leaves as a branch, only one the operator lets the caller push to
      const refused = await client.call('push', { branch: 'main', message: 'Agent work' })
      expect(refused.isError).toBe(true)
      expect(refused.text).toMatch(/you may only push to agent\/\*\*/)
      const pushed = await client.call('push', { branch: 'agent/mcp-1', message: 'Agent work' })
      const commit = execFileSync('git', ['-C', repository, 'rev-parse', 'agent/mcp-1'], { encoding: 'utf8' }).trim()
      expect(pushed).toEqual({ text: `pushed ${commit} to agent/mcp-1`, isError: false })
      expect(execFileSync('git', ['-C', repository, 'show', 'agent/mcp-1:input.txt'], { encoding: 'utf8' })).toBe(
        'from-agent\n'
      )
      expect((await client.call('changes', {})).text).toMatch(/^no changes since /)
      await client.close()
    })
  })

  itExceptWindows('runs commands and tasks, and reads their logs', async () => {
    await withSandboxServer('harness-mcp-runs', async ({ client: sandbox, connection }) => {
      const client = connect((input, output) =>
        serveMcp(
          input,
          output,
          createMcpTools(async () => sandbox),
          { name: 'hammerkit', version: '1' }
        )
      )
      expect((await client.call('bash', { command: 'ls', workdir: 'src' })).text).toBe('app.ts\n\nexit code 0')

      const busy = async () => {
        while (!(await SandboxClient.get(connection, sandbox.id)).busy) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
      // the calls of a client take turns: a write sent while its command runs lands after it
      const sleeping = client.call('bash', { command: 'sleep 2; cat busy.txt || echo none' })
      await busy()
      const written = client.call('write', { path: 'busy.txt', content: 'x' })
      expect((await sleeping).text).toMatch(/none\n\nexit code 0$/)
      expect((await written).isError).toBe(false)
      expect((await sandbox.readRaw('busy.txt')).toString()).toBe('x')

      // a run of another client that holds the sandbox is an answer for the model, not a crash
      const other = sandbox.exec('sleep 3', '')
      await busy()
      const refused = await client.call('write', { path: 'busy.txt', content: 'y' })
      expect(refused).toEqual({ isError: true, text: expect.stringMatching(/holds the sandbox/) })
      expect((await other).exitCode).toBe(0)
      const failed = await client.call('run_task', { task: 'fail' })
      expect(failed.text).toMatch(/^run run_[\w-]+: failed\ntask fail: failed, exit code 3/)
      expect(failed.text).toContain('last lines:\nbroken')
      const run = /^run (run_[\w-]+)/.exec(failed.text)?.[1]
      expect((await client.call('run_logs', { run, task: 'fail', grep: 'broken' })).text).toBe(
        '1: broken\n\n(1 lines searched, 1 match here)'
      )
      await client.close()
    })
  })

  it('starts as a command for a registered server and the sandbox it names', async () => {
    await withSandboxServer('harness-mcp-command', async ({ client: sandbox, url, environment, connection, build }) => {
      await addServer(environment, 'corp', url, { issuer: 'https://idp.example.com' })
      environment.processEnvs = { ...environment.processEnvs, HAMMERKIT_TOKEN: await connection.token() }
      const errors: string[] = []
      environment.stderr = new PassThrough().on('data', (chunk) => errors.push(chunk.toString()))
      const program = new Command().exitOverride()
      const remote = program.command('remote')
      const client = connect(async (input, output) => {
        environment.stdout = output
        registerMcpCommand(remote, environment, input)
        await program.parseAsync(['remote', 'mcp', '--server', 'corp', '--sandbox', sandbox.id, '--build', build], {
          from: 'user',
        })
      })
      const init = await client.request('initialize', { protocolVersion: '2025-06-18' })
      expect(init.result.instructions).toContain(`hammerkit sandbox ${sandbox.id}`)
      const listed = (await client.request('tools/list')).result.tools
      // the model knows the tasks it can run, but the shell, which bash runs
      const runTask = listed.find((tool: McpTool) => tool.name === 'run_task')
      expect(runTask.description).toContain('- test: run the tests (takes args)')
      expect(runTask.description).not.toContain('- sh:')
      expect((await client.call('read', { path: 'input.txt' })).text).toBe(
        '     1\tfrom-main\n\n(end of file, 1 lines)'
      )
      await client.close()
      expect(errors.join('')).toContain(`hammerkit remote mcp: sandbox ${sandbox.id} of github.com/corp/payments`)
    })
  })

  // blank as the plugins read HAMMERKIT_SHELL
  itExceptWindows('leaves out bash for a blank shell and runs the tasks of the build file', async () => {
    await withSandboxServer(
      'harness-mcp-no-shell',
      async ({ client: sandbox, url, environment, connection, build }) => {
        await addServer(environment, 'corp', url, { issuer: 'https://idp.example.com' })
        environment.processEnvs = { ...environment.processEnvs, HAMMERKIT_TOKEN: await connection.token() }
        const program = new Command().exitOverride()
        const remote = program.command('remote')
        const args = ['remote', 'mcp', '--server', 'corp', '--sandbox', sandbox.id, '--build', build, '--shell', ' ']
        const client = connect(async (input, output) => {
          environment.stdout = output
          environment.stderr = new PassThrough()
          registerMcpCommand(remote, environment, input)
          await program.parseAsync(args, { from: 'user' })
        })
        const init = await client.request('initialize', { protocolVersion: '2025-06-18' })
        expect(init.result.instructions).toContain(`run_task runs the tasks of the published build file ${build}`)
        expect(init.result.instructions).not.toContain('bash')
        const listed = (await client.request('tools/list')).result.tools
        expect(listed.map((tool: McpTool) => tool.name)).not.toContain('bash')
        expect(listed.find((tool: McpTool) => tool.name === 'run_task').description).toContain(
          '- sh: runs `sh -c` (takes args)'
        )
        const ran = await client.call('run_task', { task: 'test', args: ['--grep', 'login'] })
        expect(ran.text).toContain('last lines:\ntesting --grep login\n')
        await client.close()
      }
    )
  })

  it('reads an empty HAMMERKIT_SHELL as no shell and an unset one as the default', () => {
    expect(harnessOptionsFromEnv({ HAMMERKIT_SHELL: '' }).shell).toBe('')
    expect(harnessOptionsFromEnv({ HAMMERKIT_SHELL: ' bash ' }).shell).toBe('bash')
    expect(harnessOptionsFromEnv({}).shell).toBeUndefined()
  })

  it('takes an unchanged sandbox of the repository and ref before it creates one', async () => {
    await withSandboxServer('harness-reuse', async ({ client: first, url, environment, connection, build }) => {
      await addServer(environment, 'corp', url, { issuer: 'https://idp.example.com' })
      environment.processEnvs = { ...environment.processEnvs, HAMMERKIT_TOKEN: await connection.token() }
      const options = { server: 'corp', repo: SANDBOX_REPO, ref: 'main', build }
      // a run names exactly the version it runs, a name that would follow the latest one is no build
      await expect(connectSandbox(environment, { ...options, build: 'payments' })).rejects.toThrow(
        'payments is not the hash of a published version (sha256:...), name it as hammerkit remote publish printed it (HAMMERKIT_BUILD or --build)'
      )
      const said: string[] = []
      expect((await connectSandbox(environment, options, (line) => said.push(line))).id).toBe(first.id)
      expect(said).toEqual([expect.stringMatching(/^took sandbox .* it had no changes$/)])

      await first.writeRaw('notes.txt', 'mine\n')
      const second = await connectSandbox(environment, options, (line) => said.push(line))
      expect(second.id).not.toBe(first.id)
      expect(said[1]).toContain(`set HAMMERKIT_SANDBOX=${second.id} to come back to it`)
      expect((await first.readRaw('notes.txt')).toString()).toBe('mine\n')
      expect((await connectSandbox(environment, options)).id).toBe(second.id)
    })
  })
})
