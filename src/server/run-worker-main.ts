import { workerMain } from './run-worker'

// The process of a run without the command line, for tests that run from source
// (`vite-node src/server/run-worker-main.ts`). A build uses `hammerkit server-run`.
workerMain(process.stdin, process.stdout, process.env, process.cwd(), new AbortController()).then(
  () => process.exit(0),
  () => process.exit(1)
)
