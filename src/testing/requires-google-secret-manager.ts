// The integration spec against a real Google Secret Manager (secrets-gsm.spec.ts)
// needs a demo project and two service account keys, see examples/secrets-gsm/README.md.
// Unlike the container gates it does not no-op in CI: CI sets HAMMERKIT_FULL_INTEGRATION,
// and then missing credentials fail the spec instead of silently skipping the check.
export interface GoogleSecretManagerEnv {
  project: string
  // key file of the service account that reads hammerkit-playground
  reader: string
  // key file of the service account that reads hammerkit-playground-other
  other: string
}

export function googleSecretManagerEnv(): GoogleSecretManagerEnv | null {
  const project = process.env.GCP_PROJECT
  const reader = process.env.GSM_TEST_CREDENTIALS
  const other = process.env.GSM_OTHER_CREDENTIALS
  return project && reader && other ? { project, reader, other } : null
}

export function requiresGoogleSecretManager(fn: (env: GoogleSecretManagerEnv) => Promise<any>): () => Promise<any> {
  const env = googleSecretManagerEnv()
  if (env) {
    return () => fn(env)
  }
  if (process.env.HAMMERKIT_FULL_INTEGRATION) {
    return () =>
      Promise.reject(
        new Error(
          'GCP_PROJECT, GSM_TEST_CREDENTIALS and GSM_OTHER_CREDENTIALS are not all set but HAMMERKIT_FULL_INTEGRATION is on: ' +
            'set up the demo project of examples/secrets-gsm/README.md and add its credentials to the CI secrets'
        )
      )
  }
  return () => Promise.resolve()
}
