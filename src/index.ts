#!/usr/bin/env node

import { consoleContext } from './log'
import { getFileContext } from './file/get-file-context'
import { statusConsole } from './planner/work-item-status'
import { emptyWritable } from './utils/empty-writable'
import { runProgram } from './run-program'
import { abortOnSignals } from './utils/abort-on-signals'

const abortCtrl = new AbortController()

abortOnSignals(process, abortCtrl)

let settled = false

// A run that never settles (a task waiting on something that can't happen)
// lets the event loop drain, and Node then exits 0: CI would report success
// for a build that never finished. Fail loudly instead.
process.on('beforeExit', () => {
  if (!settled) {
    process.stderr.write('hammerkit stopped before the run finished\n')
    process.exitCode = 1
  }
})

runProgram(
  {
    cwd: process.cwd(),
    abortCtrl,
    processEnvs: process.env,
    file: getFileContext(process.cwd()),
    console: consoleContext(process.stdout),
    status: statusConsole(emptyWritable()),
    stdout: process.stdout,
    stderr: process.stderr,
    stdoutColumns: process.stdout.columns,
  },
  process.argv,
  false
).then(
  () => {
    settled = true
  },
  () => {
    settled = true
    process.exit(1)
  }
)
