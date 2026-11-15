#!/usr/bin/env node

// A server on a cluster runs `hammerkit server-sandbox <directory>` in the pod of a
// sandbox's files for every request on them. It loads the code of sandboxes only: the
// whole CLI takes most of a second to load, and more on a pod with little CPU.
if (process.argv[2] === 'server-sandbox' && process.argv.length === 4) {
  void import('./server/sandbox-pod-command').then(({ runSandboxPodCommand }) =>
    runSandboxPodCommand(process.argv[3], process.stdin, process.stdout).catch((e) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
      process.exitCode = 1
    })
  )
} else {
  void import('./main')
}
