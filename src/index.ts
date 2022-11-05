#!/usr/bin/env node

import { getProgram } from './program'
import { consoleContext } from './log'
import { getFileContext } from './file/get-file-context'
import { statusConsole } from './planner/work-node-status'
import { getContainerCli } from './executer/execute-docker'

const abortCtrl = new AbortController()

process.on('SIGINT', function () {
  abortCtrl.abort()
})

getProgram(
  {
    cwd: process.cwd(),
    abortCtrl,
    processEnvs: process.env,
    file: getFileContext(process.cwd()),
    console: consoleContext(),
    status: statusConsole(),
    docker: getContainerCli(),
  },
  process.argv
).then(({ program, args }) => {
  return program.parseAsync(args)
})
