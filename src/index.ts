#!/usr/bin/env node

import { getProgram } from './program'
import { consoleContext } from './log'
import { getFileContext } from './file/get-file-context'
import { statusConsole } from './planner/work-node-status'

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
  },
  process.argv
).then(({ program, args }) => {
  program.parse(args)
})
