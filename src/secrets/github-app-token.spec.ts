import { createVerify, generateKeyPairSync } from 'crypto'
import { join } from 'path'
import { runProgram } from '../run-program'
import { createTestCase } from '../testing/test-case'
import { memoryStream } from '../testing/test-streams'
import { GithubAppTokenDeps, githubAppToken } from './github-app-token'

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})
const NOW = 1_800_000_000_000
const SECRET = 'projects/p1/secrets/github-app-key/versions/3'

interface Call {
  url: string
  method: string
  headers: { [key: string]: string }
  body?: any
}

// A GitHub and a Google that answer what the command asks, and record what it sent.
function world(
  answers: { [url: string]: (call: Call) => { status?: number; body: unknown } } = {},
  files: { [path: string]: string } = { '/key.pem': privateKey }
) {
  const calls: Call[] = []
  const routes: { [url: string]: (call: Call) => { status?: number; body: unknown } } = {
    'https://api.github.com/repos/corp/app/installation': () => ({ body: { id: 42 } }),
    'https://api.github.com/app/installations/42/access_tokens': () => ({ status: 201, body: { token: 'ghs_minted' } }),
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token': () => ({
      body: { access_token: 'ya29.metadata' },
    }),
    'https://sts.googleapis.com/v1/token': () => ({ body: { access_token: 'ya29.federated' } }),
    [`https://secretmanager.googleapis.com/v1/${SECRET}:access`]: () => ({
      body: { payload: { data: Buffer.from(privateKey).toString('base64') } },
    }),
    ...answers,
  }
  const deps: GithubAppTokenDeps = {
    fetch: async (input, init) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? 'GET',
        headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as { [key: string]: string })),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      }
      calls.push(call)
      const route = routes[call.url]
      if (!route) {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
      }
      const answer = route(call)
      return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 })
    },
    readFile: async (path) => {
      if (!(path in files)) {
        throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' })
      }
      return Buffer.from(files[path])
    },
    now: () => NOW,
  }
  return { calls, deps }
}

function jwtOf(call: Call) {
  const [header, payload, signature] = call.headers.authorization.replace(/^Bearer /, '').split('.')
  const valid = createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, signature, 'base64url')
  return {
    valid,
    header: JSON.parse(Buffer.from(header, 'base64url').toString()),
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString()),
  }
}

describe('github-app-token', () => {
  it('mints a token of the installation for the one repository with the key of a file', async () => {
    const { calls, deps } = world()
    const token = await githubAppToken('corp/app', { GITHUB_APP_ID: '1234', GITHUB_APP_KEY_FILE: '/key.pem' }, deps)
    expect(token).toBe('ghs_minted')
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET https://api.github.com/repos/corp/app/installation',
      'POST https://api.github.com/app/installations/42/access_tokens',
    ])
    expect(calls[1].body).toEqual({ repositories: ['app'] })
    for (const call of calls) {
      const jwt = jwtOf(call)
      expect(jwt.valid).toBe(true)
      expect(jwt.header).toEqual({ alg: 'RS256', typ: 'JWT' })
      expect(jwt.payload).toEqual({ iat: NOW / 1000 - 60, exp: NOW / 1000 + 540, iss: '1234' })
    }
  })

  it('reads the key from Secret Manager as the identity of the metadata server', async () => {
    const { calls, deps } = world()
    const token = await githubAppToken('corp/app', { GITHUB_APP_ID: '1234', GITHUB_APP_KEY_SECRET: SECRET }, deps)
    expect(token).toBe('ghs_minted')
    expect(calls[0]).toMatchObject({ headers: { 'metadata-flavor': 'Google' } })
    expect(calls[1]).toMatchObject({
      url: `https://secretmanager.googleapis.com/v1/${SECRET}:access`,
      headers: { authorization: 'Bearer ya29.metadata' },
    })
    expect(jwtOf(calls[2]).valid).toBe(true)
  })

  it('reads the key from Secret Manager as a federated identity of a token file', async () => {
    const { calls, deps } = world(
      {},
      {
        '/creds.json': JSON.stringify({
          type: 'external_account',
          audience: '//iam.googleapis.com/projects/9/locations/global/workloadIdentityPools/k8s/providers/gke',
          subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
          token_url: 'https://sts.googleapis.com/v1/token',
          credential_source: { file: '/var/run/secrets/tokens/gcp' },
        }),
        '/var/run/secrets/tokens/gcp': 'eyJ.kubernetes.token\n',
      }
    )
    const env = { GITHUB_APP_ID: '1234', GITHUB_APP_KEY_SECRET: SECRET, GOOGLE_APPLICATION_CREDENTIALS: '/creds.json' }
    expect(await githubAppToken('corp/app', env, deps)).toBe('ghs_minted')
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://sts.googleapis.com/v1/token',
      body: {
        grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
        audience: '//iam.googleapis.com/projects/9/locations/global/workloadIdentityPools/k8s/providers/gke',
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        subjectToken: 'eyJ.kubernetes.token',
      },
    })
    expect(calls[1].headers.authorization).toBe('Bearer ya29.federated')
  })

  it('acts as the service account a federated identity impersonates', async () => {
    const impersonate =
      'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/hk@p1.iam.gserviceaccount.com:generateAccessToken'
    const { calls, deps } = world(
      { [impersonate]: () => ({ body: { accessToken: 'ya29.service-account' } }) },
      {
        '/creds.json': JSON.stringify({
          type: 'external_account',
          audience: '//iam.googleapis.com/x',
          credential_source: { file: '/token.json', format: { type: 'json', subject_token_field_name: 'id_token' } },
          service_account_impersonation_url: impersonate,
        }),
        '/token.json': JSON.stringify({ id_token: 'eyJ.oidc' }),
      }
    )
    const env = { GITHUB_APP_ID: '1234', GITHUB_APP_KEY_SECRET: SECRET, GOOGLE_APPLICATION_CREDENTIALS: '/creds.json' }
    expect(await githubAppToken('corp/app', env, deps)).toBe('ghs_minted')
    expect(calls[0].body.subjectToken).toBe('eyJ.oidc')
    expect(calls[1]).toMatchObject({ url: impersonate, headers: { authorization: 'Bearer ya29.federated' } })
    expect(calls[2].headers.authorization).toBe('Bearer ya29.service-account')
  })

  it('mints a token of all repositories of the installation of an owner', async () => {
    const { calls, deps } = world({
      'https://api.github.com/orgs/corp/installation': () => ({ body: { id: 42 } }),
      'https://api.github.com/orgs/someone/installation': () => ({ status: 404, body: { message: 'Not Found' } }),
      'https://api.github.com/users/someone/installation': () => ({ body: { id: 42 } }),
      'https://api.github.com/orgs/nobody/installation': () => ({ status: 404, body: { message: 'Not Found' } }),
      'https://api.github.com/users/nobody/installation': () => ({ status: 404, body: { message: 'Not Found' } }),
    })
    const env = { GITHUB_APP_ID: '1234', GITHUB_APP_KEY_FILE: '/key.pem' }
    expect(await githubAppToken('corp', env, deps)).toBe('ghs_minted')
    expect(calls[1]).toMatchObject({ method: 'POST', body: undefined })
    expect(await githubAppToken('someone', env, deps)).toBe('ghs_minted')
    expect(calls.slice(2).map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET https://api.github.com/orgs/someone/installation',
      'GET https://api.github.com/users/someone/installation',
      'POST https://api.github.com/app/installations/42/access_tokens',
    ])
    await expect(githubAppToken('nobody', env, deps)).rejects.toThrow(
      'the GitHub App 1234 is not installed on nobody: 404 Not Found'
    )
  })

  it('asks a GitHub Enterprise Server at GITHUB_API_URL', async () => {
    const api = 'https://github.corp.com/api/v3'
    const { calls, deps } = world({
      [`${api}/repos/corp/app/installation`]: () => ({ body: { id: 7 } }),
      [`${api}/app/installations/7/access_tokens`]: () => ({ status: 201, body: { token: 'ghs_enterprise' } }),
    })
    const env = { GITHUB_APP_ID: '1234', GITHUB_APP_KEY_FILE: '/key.pem', GITHUB_API_URL: `${api}/` }
    expect(await githubAppToken('corp/app', env, deps)).toBe('ghs_enterprise')
    expect(calls.map((call) => call.url)).toEqual([
      `${api}/repos/corp/app/installation`,
      `${api}/app/installations/7/access_tokens`,
    ])
  })

  it('says what is missing before it asks anybody', async () => {
    const { calls, deps } = world()
    await expect(githubAppToken('corp/app/x', { GITHUB_APP_ID: '1' }, deps)).rejects.toThrow(
      'corp/app/x is not a repository: name it as owner/repo, or owner for all of an installation'
    )
    await expect(githubAppToken('corp/app', { GITHUB_APP_KEY_FILE: '/key.pem' }, deps)).rejects.toThrow(
      'GITHUB_APP_ID is not set'
    )
    await expect(githubAppToken('corp/app', { GITHUB_APP_ID: '1' }, deps)).rejects.toThrow(
      'set one of GITHUB_APP_KEY_SECRET (a Secret Manager version) and GITHUB_APP_KEY_FILE'
    )
    await expect(
      githubAppToken(
        'corp/app',
        { GITHUB_APP_ID: '1', GITHUB_APP_KEY_FILE: '/key.pem', GITHUB_APP_KEY_SECRET: SECRET },
        deps
      )
    ).rejects.toThrow('set one of')
    await expect(
      githubAppToken('corp/app', { GITHUB_APP_ID: '1', GITHUB_APP_KEY_SECRET: 'github-app-key' }, deps)
    ).rejects.toThrow('GITHUB_APP_KEY_SECRET is not a version: projects/<project>/secrets/<secret>/versions/<version>')
    await expect(
      githubAppToken('corp/app', { GITHUB_APP_ID: '1', GITHUB_APP_KEY_FILE: '/gone.pem' }, deps)
    ).rejects.toThrow('could not read GITHUB_APP_KEY_FILE /gone.pem: ENOENT')
    expect(calls).toEqual([])
  })

  it('takes no key of a Google service account', async () => {
    const { deps } = world({}, { '/sa.json': JSON.stringify({ type: 'service_account', private_key: 'x' }) })
    const env = { GITHUB_APP_ID: '1', GITHUB_APP_KEY_SECRET: SECRET, GOOGLE_APPLICATION_CREDENTIALS: '/sa.json' }
    await expect(githubAppToken('corp/app', env, deps)).rejects.toThrow(
      'GOOGLE_APPLICATION_CREDENTIALS /sa.json is not an external_account with a credential_source file'
    )
  })

  it('says which step failed and what the service said, never the key or a token', async () => {
    const env = { GITHUB_APP_ID: '1234', GITHUB_APP_KEY_SECRET: SECRET }
    const failures: Array<[ReturnType<typeof world>, string]> = [
      [
        world({
          'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token': () => {
            throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
          },
        }),
        'the metadata server gave no Google token (and GOOGLE_APPLICATION_CREDENTIALS is not set): metadata.google.internal could not be reached (ENOTFOUND)',
      ],
      [
        world({
          [`https://secretmanager.googleapis.com/v1/${SECRET}:access`]: () => ({
            status: 403,
            body: { error: { code: 403, message: "Permission 'secretmanager.versions.access' denied" } },
          }),
        }),
        `Secret Manager did not give ${SECRET}: 403 Permission 'secretmanager.versions.access' denied`,
      ],
      [
        world({
          [`https://secretmanager.googleapis.com/v1/${SECRET}:access`]: () => ({
            body: { payload: { data: Buffer.from('not a key').toString('base64') } },
          }),
        }),
        'the key of the GitHub App is not an RSA private key in PEM',
      ],
      [
        world({
          'https://api.github.com/repos/corp/app/installation': () => ({ status: 404, body: { message: 'Not Found' } }),
        }),
        'the GitHub App 1234 is not installed on corp/app: 404 Not Found',
      ],
      [
        world({
          'https://api.github.com/app/installations/42/access_tokens': () => ({
            status: 422,
            body: { message: 'There is at least one repository that does not exist or is not accessible' },
          }),
        }),
        'GitHub did not give the App a token for corp/app: 422 There is at least one repository',
      ],
    ]
    for (const [{ deps }, message] of failures) {
      const error: Error = await githubAppToken('corp/app', env, deps).then(
        () => new Error('no error'),
        (e) => e
      )
      expect(error.message).toContain(message)
      for (const secret of ['PRIVATE KEY', 'ya29.', 'ghs_', 'Bearer']) {
        expect(error.message).not.toContain(secret)
      }
    }
  })

  it('prints the token and nothing else as a command', async () => {
    const { deps } = world()
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(deps.fetch)
    const t = createTestCase('github-app-token', {})
    try {
      await t.setup(async (cwd, environment) => {
        const key = join(cwd, 'key.pem')
        await environment.file.writeFile(key, privateKey)
        const stdout = memoryStream()
        environment.stdout = stdout.stream
        environment.processEnvs = { GITHUB_APP_ID: '1234', GITHUB_APP_KEY_FILE: key }
        await runProgram(environment, ['hammerkit', 'github-app-token', 'corp/app'], true)
        expect(stdout.read()).toBe('ghs_minted')
      })
    } finally {
      fetch.mockRestore()
    }
  })
})
