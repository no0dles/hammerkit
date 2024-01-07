#!/usr/bin/env node

import { consoleContext } from './log'
import { getFileContext } from './file/get-file-context'
import { statusConsole } from './planner/work-item-status'
import { emptyWritable } from './utils/empty-writable'
import { runProgram } from './run-program'

const abortCtrl = new AbortController()

process.on('SIGINT', function () {
  abortCtrl.abort()
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
).catch(() => {
  process.exit(1)
})
