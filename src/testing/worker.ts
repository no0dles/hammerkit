import { join } from 'path'

// The process of a run, started from the source of this repository: tests run before
// there is a build, so `vite-node` stands in for `node dist/index.js server-run`.
export const TEST_WORKER = [
  process.execPath,
  join(process.cwd(), 'node_modules', 'vite-node', 'vite-node.mjs'),
  join(process.cwd(), 'src', 'server', 'run-worker-main.ts'),
]
