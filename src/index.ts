#!/usr/bin/env node

import { join } from 'path'
import { getProgram } from './program'

const program = getProgram(join(process.cwd(), 'build.yaml'))
program.parse(process.argv)
