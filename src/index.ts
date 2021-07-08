#!/usr/bin/env node

import { getProgram } from './program'
import { Defer } from './defer'
import { fileContext } from './run-arg'
import { consoleContext } from './log'

const cancelDefer = new Defer<void>()

process.on('SIGINT', function () {
  if (!cancelDefer.isResolved) {
    cancelDefer.resolve()
  }
})

getProgram({
  cwd: process.cwd(),
  cancelDefer,
  processEnvs: process.env,
  file: fileContext(),
  console: consoleContext(),
}).then((program) => {
  program.parse(process.argv)
})
