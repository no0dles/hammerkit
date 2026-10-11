import { join } from 'path'
import { statSync, readFileSync, writeFileSync } from 'fs'
import { createTestCase } from '../testing/test-case'
import { Environment } from '../executer/environment'
import { getAccessToken, getCredentialsPath, removeToken, saveToken } from './credentials'

const server = { url: 'https://build.corp', issuer: 'https://idp.corp' }
const token = (extra = {}) => ({ ...server, accessToken: 'secret-token', expiresAt: 10_000, ...extra })

async function withCredentials(name: string, fn: (env: Environment, file: string) => Promise<void>) {
  await createTestCase(name, {}).setup(async (cwd, env) => {
    const file = join(cwd, 'nested', 'credentials.json')
    env.processEnvs = { ...env.processEnvs, HAMMERKIT_CREDENTIALS: file }
    await fn(env, file)
  })
}

describe('credentials', () => {
  it('keeps a sign-in per server, readable by its owner only', async () => {
    await withCredentials('credentials-save', async (env, file) => {
      expect(getCredentialsPath(env)).toBe(file)
      await saveToken(env, 'build', token())
      await saveToken(env, 'mac', token({ accessToken: 'other' }))
      expect(await getAccessToken(env, 'build', server, 5000)).toBe('secret-token')
      expect(await getAccessToken(env, 'mac', server, 5000)).toBe('other')
      if (process.platform !== 'win32') {
        expect(statSync(file).mode & 0o777).toBe(0o600)
      }
    })
  })

  it('tightens the mode of a file that was too open', async () => {
    await withCredentials('credentials-mode', async (env, file) => {
      await saveToken(env, 'build', token())
      if (process.platform !== 'win32') {
        const { chmodSync } = await import('fs')
        chmodSync(file, 0o644)
        await saveToken(env, 'build', token())
        expect(statSync(file).mode & 0o777).toBe(0o600)
      }
    })
  })

  it('says to sign in when there is no token or it has expired', async () => {
    await withCredentials('credentials-missing', async (env) => {
      await expect(getAccessToken(env, 'build', server)).rejects.toThrow(
        'not signed in to build, sign in with: hammerkit remote login build'
      )
      await saveToken(env, 'build', token())
      await expect(getAccessToken(env, 'build', server, 10_000)).rejects.toThrow('has expired')
    })
  })

  it('does not hand a token to a server it was not made for', async () => {
    await withCredentials('credentials-repointed', async (env) => {
      await saveToken(env, 'build', token())
      await expect(getAccessToken(env, 'build', { ...server, url: 'https://evil.example' }, 5000)).rejects.toThrow(
        'made for another server'
      )
      await expect(getAccessToken(env, 'build', { ...server, issuer: 'https://evil.example' }, 5000)).rejects.toThrow(
        'made for another server'
      )
    })
  })

  it('removes a sign-in and says whether there was one', async () => {
    await withCredentials('credentials-remove', async (env, file) => {
      expect(await removeToken(env, 'build')).toBe(false)
      await saveToken(env, 'build', token())
      expect(await removeToken(env, 'build')).toBe(true)
      expect(readFileSync(file, 'utf8')).toBe('{}')
    })
  })

  it('treats a damaged file as no sign-in', async () => {
    await withCredentials('credentials-damaged', async (env, file) => {
      await saveToken(env, 'build', token())
      writeFileSync(file, '{not json')
      await expect(getAccessToken(env, 'build', server, 5000)).rejects.toThrow('not signed in')
      await saveToken(env, 'build', token())
      expect(await getAccessToken(env, 'build', server, 5000)).toBe('secret-token')
    })
  })

  it('uses a file in the hammerkit directory by default', async () => {
    await createTestCase('credentials-default', {}).setup(async (_cwd, env) => {
      delete env.processEnvs.HAMMERKIT_CREDENTIALS
      expect(getCredentialsPath(env)).toMatch(/hammerkit[\\/]credentials\.json$/)
    })
  })
})
