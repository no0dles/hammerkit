// A stand-in for gcloud / op in specs: `node fake-secret-cli.cjs <mode> [ref]`.
// It prints what the real CLIs would from the environment it was given, and
// records each call to $FAKE_CALLS (a provider `env`), one JSON line per call.
const { appendFileSync } = require('fs')

const [mode, ref] = process.argv.slice(2)

if (process.env.FAKE_CALLS) {
  appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ mode, ref, token: process.env.FAKE_TOKEN ?? null }) + '\n')
}

switch (mode) {
  case 'value':
    // the value ends in a newline on purpose: it must arrive verbatim
    process.stdout.write(`value-of-${ref}-as-${process.env.FAKE_TOKEN ?? 'nobody'}\n`)
    break
  case 'static':
    // the same value whoever asks
    process.stdout.write(`static-of-${ref}`)
    break
  case 'empty':
    break
  case 'fail':
    process.stderr.write(`denied: ${ref} ${process.env.FAKE_TOKEN ?? ''}\n`)
    process.exit(3)
    break
  case 'hang':
    setInterval(() => undefined, 1000)
    break
  case 'env':
    process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))
    break
  default:
    process.stderr.write(`unknown mode ${mode}\n`)
    process.exit(2)
}
