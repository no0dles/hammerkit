#!/usr/bin/env node

import { consoleContext } from './log'
import { getFileContext } from './file/get-file-context'
import { statusConsole } from './planner/work-node-status'
import { getContainerCli } from './executer/execute-docker'
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
    docker: getContainerCli(),
    stdout: process.stdout,
    stderr: process.stderr,
    stdoutColumns: process.stdout.columns,
  },
  process.argv,
  false
)
