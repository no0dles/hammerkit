import { spawn } from 'child_process'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { it } from 'vitest'

function ps(env: any, cwd: string, ms: number) {
  return new Promise<number>((resolve) => {
    const started = Date.now()
    const c = spawn('echo hi', { env, cwd, shell: 'powershell.exe' })
    const timer = setTimeout(() => {
      c.kill()
      resolve(ms)
    }, ms)
    c.stdout?.on('data', () => undefined)
    c.on('error', () => undefined)
    c.on('close', () => {
      clearTimeout(timer)
      resolve(Date.now() - started)
    })
  })
}

async function pool<T>(items: string[], size: number, fn: (item: string) => Promise<T>) {
  const results: [string, T][] = []
  let i = 0
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (i < items.length) {
        const item = items[i++]
        results.push([item, await fn(item)])
      }
    })
  )
  return results
}

it('windows debug', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'win-debug-'))
  writeFileSync(join(dir, 'input.txt'), 'hello')
  const keys = Object.keys(process.env)
  const log: string[] = []
  log.push(`keys=${keys.length}`)
  const full = { ...process.env }
  log.push('full: ' + (await ps(full, dir, 15000)))
  log.push('PATH only: ' + (await ps({ PATH: process.env.PATH }, dir, 15000)))
  // essential: removing the key makes it slow
  const removal = await pool(keys, 6, async (k) => {
    const env = { ...full }
    delete env[k]
    return ps(env, dir, 10000)
  })
  log.push('slow without: ' + JSON.stringify(removal.filter(([, t]) => t > 5000)))
  // sufficient: PATH plus this key alone is fast
  const addition = await pool(keys, 6, async (k) => ps({ PATH: process.env.PATH, [k]: process.env[k] }, dir, 10000))
  log.push('fast with only: ' + JSON.stringify(addition.filter(([, t]) => t < 5000)))
  throw new Error('DEBUG\n' + log.join('\n'))
}, 600000)
