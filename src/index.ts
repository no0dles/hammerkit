#!/usr/bin/env node

import { getProgram } from './program'

const program = getProgram(process.cwd())
program.parse(process.argv)
