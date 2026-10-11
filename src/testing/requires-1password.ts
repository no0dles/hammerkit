// The integration spec against a real 1Password (secrets-1password.spec.ts) needs a
// demo vault pair and two service account tokens, see examples/secrets-1password/README.md.
// Like the Google Secret Manager spec it does not no-op in CI: CI sets
// HAMMERKIT_FULL_INTEGRATION, and then missing credentials fail the spec instead of
// silently skipping the check.
export interface OnePasswordEnv {
  // file with the token of the service account that reads the vault hammerkit-demo
  readerTokenFile: string
  // file with the token of the service account that reads the vault hammerkit-demo-other
  otherTokenFile: string
}

export function onePasswordEnv(): OnePasswordEnv | null {
  const readerTokenFile = process.env.OP_TEST_TOKEN_FILE
  const otherTokenFile = process.env.OP_OTHER_TOKEN_FILE
  return readerTokenFile && otherTokenFile ? { readerTokenFile, otherTokenFile } : null
}

export function requiresOnePassword(fn: (env: OnePasswordEnv) => Promise<any>): () => Promise<any> {
  const env = onePasswordEnv()
  if (env) {
    return () => fn(env)
  }
  if (process.env.HAMMERKIT_FULL_INTEGRATION) {
    return () =>
      Promise.reject(
        new Error(
          'OP_TEST_TOKEN_FILE and OP_OTHER_TOKEN_FILE are not both set but HAMMERKIT_FULL_INTEGRATION is on: ' +
            'set up the demo vaults of examples/secrets-1password/README.md and add the tokens to the CI secrets'
        )
      )
  }
  return () => Promise.resolve()
}
