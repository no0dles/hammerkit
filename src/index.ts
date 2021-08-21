#!/usr/bin/env node

import { getProgram } from './program'
import { consoleContext } from './log'
import { getFileContext } from './file/get-file-context'

const cancelDefer = new AbortController()

process.on('SIGINT', function () {
  cancelDefer.abort()
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
