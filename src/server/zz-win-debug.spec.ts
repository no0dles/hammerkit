import { spawn } from 'child_process'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { it } from 'vitest'
import { getCli } from '../cli'
import { getFileContext } from '../file/get-file-context'
import { consoleContext } from '../log'
import { createParseContext } from '../schema/schema-parser'
import { parseReferences } from '../schema/reference-parser'
import { getWorkContext } from '../schema/work-scope-parser'
import { statusConsole } from '../planner/work-item-status'
import { createSecretRegistry } from '../utils/redact'
import { emptyWritable } from '../utils/empty-writable'
import { passedEnvironment } from './executor'

const timeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<T>((r) => setTimeout(() => r(`TIMEOUT ${what}` as any), ms))])

function ps(env: any, cwd: string) {
  return new Promise<string>((resolve) => {
    const started = Date.now()
    const c = spawn('echo hi; cat input.txt', { env, cwd, shell: 'powershell.exe' })
    let out = ''
    c.stdout?.on('data', (d) => (out += d))
    c.stderr?.on('data', (d) => (out += 'E:' + d))
    c.on('error', (e) => resolve('error ' + e.message))
    c.on('close', (code) => resolve(`code=${code} ${Date.now() - started}ms out=${JSON.stringify(out)}`))
  })
}

it('windows debug', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'win-debug-'))
  writeFileSync(join(dir, 'input.txt'), 'hello')
  writeFileSync(join(dir, '.hammerkit.yaml'), 'tasks:\n  build:\n    cmds: [cat input.txt]\n')
  const log: string[] = []
  log.push('platform ' + process.platform)
  log.push('ps path-only: ' + (await timeout(ps({ PATH: process.env.PATH }, dir), 30000, 'ps-path')))
  log.push('ps passed: ' + (await timeout(ps({ ...passedEnvironment(process.env) }, dir), 30000, 'ps-passed')))
  log.push('ps full: ' + (await timeout(ps(process.env, dir), 30000, 'ps-full')))
  for (const [name, envs] of [
    ['passed', passedEnvironment(process.env)],
    ['full', process.env],
  ] as const) {
    const abortCtrl = new AbortController()
    const secrets = createSecretRegistry()
    const status = statusConsole(emptyWritable(), secrets)
    const lines: string[] = []
    status.on((m: any) => {
      lines.push(`${m.type}:${m.message ?? ''}`)
    })
    const environment: any = {
      processEnvs: envs,
      abortCtrl,
      cwd: dir,
      file: getFileContext(dir),
      console: consoleContext(emptyWritable()),
      status,
      secrets,
      stdout: emptyWritable(),
      stderr: emptyWritable(),
      stdoutColumns: 120,
    }
    const t = Date.now()
    const result = await timeout(
      (async () => {
        const { ctx, scope } = await createParseContext(join(dir, '.hammerkit.yaml'), environment)
        log.push(name + ' parsed ' + (Date.now() - t))
        const tree = getWorkContext(
          await parseReferences(ctx, scope, environment),
          { taskName: 'build', environmentName: null } as any,
          environment
        )
        log.push(name + ' planned ' + (Date.now() - t))
        const cli = getCli(tree, environment)
        const exec = cli.exec({ logMode: 'live', workers: cli.defaultWorkers() } as any)
        const r = await exec.start()
        return 'success=' + r.success
      })(),
      60000,
      name + '-exec'
    )
    log.push(`${name} exec: ${result} ${Date.now() - t}ms lines=${JSON.stringify(lines.slice(0, 20))}`)
    abortCtrl.abort()
  }
  throw new Error('DEBUG\n' + log.join('\n'))
}, 300000)
