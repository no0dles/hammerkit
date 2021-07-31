#!/usr/bin/env node

import { getProgram } from './program'
import { consoleContext } from './log'
import { getFileContext } from './file/get-file-context'
import { Defer } from './utils/defer'

const cancelDefer = new Defer<void>()

process.on('SIGINT', function () {
  if (!cancelDefer.isResolved) {
    cancelDefer.resolve()
  }
})

getProgram(
  {
    cwd: process.cwd(),
    cancelDefer,
    processEnvs: process.env,
    file: getFileContext(),
    console: consoleContext(),
  },
  process.argv
).then(({ program, args }) => {
  program.parse(args)
})
