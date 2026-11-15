import { createSign } from 'crypto'
import { readFile } from 'fs/promises'

// What `hammerkit github-app-token` needs to talk to GitHub and Google. Tests pass their own.
export interface GithubAppTokenDeps {
  fetch: typeof fetch
  readFile: (path: string) => Promise<Buffer>
  now: () => number
}

const defaultDeps: GithubAppTokenDeps = {
  fetch: (input, init) => fetch(input, init),
  readFile: (path) => readFile(path),
  now: () => Date.now(),
}

const CLOUD_PLATFORM = 'https://www.googleapis.com/auth/cloud-platform'
const METADATA_TOKEN = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'
const REQUEST_TIMEOUT_MS = 20 * 1000

/**
 * An installation token of a GitHub App for one repository (`owner/repo`), as a secret
 * provider command prints it: the App's key signs a JWT, the JWT asks for a token of the
 * installation on that repository, limited to it. For an owner alone (`owner`) the token
 * covers every repository the installation of that owner may reach. The key is read from Google Secret
 * Manager (`GITHUB_APP_KEY_SECRET`) as the workload's own Google identity, or from a file
 * (`GITHUB_APP_KEY_FILE`). Errors say which step failed and never hold the key or a token.
 */
export async function githubAppToken(
  repo: string,
  env: { [key: string]: string | undefined },
  deps: GithubAppTokenDeps = defaultDeps
): Promise<string> {
  const match = /^([A-Za-z0-9-]+)(?:\/([A-Za-z0-9._-]+))?$/.exec(repo)
  if (!match) {
    throw new Error(`${repo} is not a repository: name it as owner/repo, or owner for all of an installation`)
  }
  const [, owner, name] = match
  const appId = env.GITHUB_APP_ID
  if (!appId) {
    throw new Error('GITHUB_APP_ID is not set')
  }
  const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '')
  const key = await appKey(env, deps)

  const now = Math.floor(deps.now() / 1000)
  // a minute back for the clock of GitHub, and under its limit of ten minutes
  const unsigned = `${base64url({ alg: 'RS256', typ: 'JWT' })}.${base64url({
    iat: now - 60,
    exp: now + 540,
    iss: appId,
  })}`
  let signature: string
  try {
    signature = createSign('RSA-SHA256').update(unsigned).sign(key, 'base64url')
  } catch {
    throw new Error('the key of the GitHub App is not an RSA private key in PEM')
  }
  const headers = {
    authorization: `Bearer ${unsigned}.${signature}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  }
  const notInstalled = `the GitHub App ${appId} is not installed on ${repo}`
  const installation = name
    ? await request<{ id?: number }>(deps, `${api}/repos/${repo}/installation`, { headers }, (status) =>
        status === 404 ? notInstalled : `GitHub did not find the App on ${repo}`
      )
    : // an organisation, else a user
      (await request<{ id?: number }>(
        deps,
        `${api}/orgs/${owner}/installation`,
        { headers },
        () => `GitHub did not find the App on ${owner}`,
        true
      )) ??
      (await request<{ id?: number }>(deps, `${api}/users/${owner}/installation`, { headers }, (status) =>
        status === 404 ? notInstalled : `GitHub did not find the App on ${owner}`
      ))
  const created = await request<{ token?: string }>(
    deps,
    `${api}/app/installations/${installation.id}/access_tokens`,
    { method: 'POST', headers, ...(name ? { body: JSON.stringify({ repositories: [name] }) } : {}) },
    () => `GitHub did not give the App a token for ${repo}`
  )
  if (!created.token) {
    throw new Error(`GitHub did not give the App a token for ${repo}: the answer has no token`)
  }
  return created.token
}

async function appKey(env: { [key: string]: string | undefined }, deps: GithubAppTokenDeps): Promise<Buffer> {
  const secret = env.GITHUB_APP_KEY_SECRET
  const file = env.GITHUB_APP_KEY_FILE
  if (!!secret === !!file) {
    throw new Error('set one of GITHUB_APP_KEY_SECRET (a Secret Manager version) and GITHUB_APP_KEY_FILE')
  }
  if (file) {
    try {
      return await deps.readFile(file)
    } catch (e) {
      throw new Error(
        `could not read GITHUB_APP_KEY_FILE ${file}: ${(e as NodeJS.ErrnoException).code ?? 'unreadable'}`
      )
    }
  }
  if (!/^projects\/[^/]+\/secrets\/[^/]+\/versions\/[^/]+$/.test(secret as string)) {
    throw new Error('GITHUB_APP_KEY_SECRET is not a version: projects/<project>/secrets/<secret>/versions/<version>')
  }
  const accessToken = await googleAccessToken(env, deps)
  const version = await request<{ payload?: { data?: string } }>(
    deps,
    `https://secretmanager.googleapis.com/v1/${secret}:access`,
    { headers: { authorization: `Bearer ${accessToken}` } },
    () => `Secret Manager did not give ${secret}`
  )
  if (!version.payload?.data) {
    throw new Error(`Secret Manager did not give ${secret}: the version has no data`)
  }
  return Buffer.from(version.payload.data, 'base64')
}

interface ExternalAccount {
  type?: string
  audience?: string
  subject_token_type?: string
  token_url?: string
  service_account_impersonation_url?: string
  credential_source?: { file?: string; format?: { type?: string; subject_token_field_name?: string } }
}

// The workload's own Google identity, without a key of Google's: a federated identity from
// GOOGLE_APPLICATION_CREDENTIALS (a token file, such as a projected Kubernetes service
// account token, exchanged at Google's STS), else the metadata server (GCE, Cloud Run, GKE).
async function googleAccessToken(env: { [key: string]: string | undefined }, deps: GithubAppTokenDeps) {
  const path = env.GOOGLE_APPLICATION_CREDENTIALS
  if (!path) {
    const token = await request<{ access_token?: string }>(
      deps,
      METADATA_TOKEN,
      { headers: { 'metadata-flavor': 'Google' } },
      () => 'the metadata server gave no Google token (and GOOGLE_APPLICATION_CREDENTIALS is not set)'
    )
    return required(token.access_token, 'the metadata server gave no Google token')
  }
  let account: ExternalAccount
  try {
    account = JSON.parse((await deps.readFile(path)).toString('utf8'))
  } catch {
    throw new Error(`GOOGLE_APPLICATION_CREDENTIALS ${path} is not a readable JSON file`)
  }
  const source = account.credential_source?.file
  if (account.type !== 'external_account' || !source || !account.audience) {
    throw new Error(
      `GOOGLE_APPLICATION_CREDENTIALS ${path} is not an external_account with a credential_source file; a key of a service account is not taken`
    )
  }
  let subject: string
  try {
    const content = (await deps.readFile(source)).toString('utf8')
    const format = account.credential_source?.format
    subject = format?.type === 'json' ? JSON.parse(content)[format.subject_token_field_name ?? ''] : content.trim()
  } catch {
    throw new Error(`could not read the subject token file ${source} of GOOGLE_APPLICATION_CREDENTIALS`)
  }
  if (!subject) {
    throw new Error(`the subject token file ${source} of GOOGLE_APPLICATION_CREDENTIALS is empty`)
  }
  const exchanged = await request<{ access_token?: string }>(
    deps,
    account.token_url ?? 'https://sts.googleapis.com/v1/token',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
        audience: account.audience,
        scope: CLOUD_PLATFORM,
        requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
        subjectToken: subject,
        subjectTokenType: account.subject_token_type ?? 'urn:ietf:params:oauth:token-type:jwt',
      }),
    },
    () => `Google STS did not exchange the token of ${source} for ${account.audience}`
  )
  const federated = required(exchanged.access_token, 'Google STS gave no token')
  if (!account.service_account_impersonation_url) {
    return federated
  }
  // the pool's identity acts as a service account of Google
  const impersonated = await request<{ accessToken?: string }>(
    deps,
    account.service_account_impersonation_url,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${federated}`, 'content-type': 'application/json' },
      body: JSON.stringify({ scope: [CLOUD_PLATFORM] }),
    },
    () => 'Google did not let the federated identity act as the service account'
  )
  return required(impersonated.accessToken, 'Google gave no token of the service account')
}

// A JSON answer, or an error with what failed, the status and what the service said: the
// services answer errors with a message, never with the credential that was sent.
async function request<T>(
  deps: GithubAppTokenDeps,
  url: string,
  init: RequestInit,
  failed: (status: number) => string
): Promise<T>
async function request<T>(
  deps: GithubAppTokenDeps,
  url: string,
  init: RequestInit,
  failed: (status: number) => string,
  missing: true
): Promise<T | undefined>
async function request<T>(
  deps: GithubAppTokenDeps,
  url: string,
  init: RequestInit,
  failed: (status: number) => string,
  missing?: true
): Promise<T | undefined> {
  let response: Response
  try {
    response = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause?.code ?? (e instanceof Error ? e.message : String(e))
    throw new Error(`${failed(0)}: ${new URL(url).host} could not be reached (${cause})`)
  }
  const text = await response.text()
  if (missing && response.status === 404) {
    return undefined
  }
  if (!response.ok) {
    throw new Error(`${failed(response.status)}: ${response.status} ${said(text)}`.trim())
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`${failed(response.status)}: the answer is not JSON`)
  }
}

function said(text: string): string {
  try {
    const body = JSON.parse(text)
    const message = body.message ?? body.error_description ?? body.error?.message ?? body.error
    if (typeof message === 'string') {
      return message.slice(0, 300)
    }
  } catch {
    // not JSON: only the status is said
  }
  return ''
}

function required(value: string | undefined, message: string): string {
  if (!value) {
    throw new Error(message)
  }
  return value
}

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}
