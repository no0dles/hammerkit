#!/usr/bin/env node

import { getProgram } from './program'
import { consoleContext } from './log'
import { getFileContext } from './file/get-file-context'

const abortCtrl = new AbortController()

process.on('SIGINT', function () {
  abortCtrl.abort()
})

getProgram(
  {
    cwd: process.cwd(),
    abortCtrl,
    processEnvs: process.env,
    file: getFileContext(),
    console: consoleContext(),
  },
  process.argv
).then(({ program, args }) => {
  program.parse(args)
})
