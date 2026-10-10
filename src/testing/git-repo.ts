import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { pathToFileURL } from 'url'

// A real git repository for remote-include specs ("real integrations over
// mocks"): commits are made by the git binary, and the repository is addressed by
// file URL, the transport a remote would use.
export interface GitRepo {
  path: string
  url: string
  commit(files: { [fileName: string]: string }, message?: string): string
  branch(name: string): void
  tag(name: string): void
  remove(): void
}

function run(cwd: string, args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' }
  ).trim()
}

export function createGitRepo(): GitRepo {
  const path = mkdtempSync(join(tmpdir(), 'hammerkit-git-'))
  run(path, ['init', '--quiet', '--initial-branch=main'])
  return {
    path,
    url: pathToFileURL(path).href,
    commit(files, message = 'commit') {
      for (const [fileName, content] of Object.entries(files)) {
        mkdirSync(dirname(join(path, fileName)), { recursive: true })
        writeFileSync(join(path, fileName), content)
      }
      run(path, ['add', '--all'])
      run(path, ['commit', '--quiet', '--message', message])
      return run(path, ['rev-parse', 'HEAD'])
    },
    branch(name) {
      run(path, ['branch', '--force', name])
    },
    tag(name) {
      run(path, ['tag', name])
    },
    remove() {
      rmSync(path, { recursive: true, force: true })
    },
  }
}

// Points the per-user hammerkit directory (and with it the include cache) at an
// empty folder, so a spec never touches or depends on the developer's own cache.
export function isolateHammerkitHome(): { restore(): void; path: string } {
  const path = mkdtempSync(join(tmpdir(), 'hammerkit-home-'))
  const original = { HOME: process.env.HOME, APPDATA: process.env.APPDATA }
  if (process.platform === 'win32') {
    process.env.APPDATA = path
  } else {
    process.env.HOME = path
  }
  return {
    path,
    restore() {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
      rmSync(path, { recursive: true, force: true })
    },
  }
}
