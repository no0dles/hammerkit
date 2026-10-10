import { join } from 'path'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { environmentMock } from '../executer/environment-mock'
import {
  addServer,
  getHostConfigPath,
  normalizeServerUrl,
  readHostConfig,
  removeServer,
  setDefaultLocation,
  validateServerName,
} from './host-config'

describe('host config', () => {
  let dir: string
  let environment: ReturnType<typeof environmentMock>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hammerkit-host-config-'))
    environment = environmentMock(dir)
    environment.processEnvs = { HAMMERKIT_CONFIG: join(dir, 'nested', 'config.yaml') }
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads an empty config when the file does not exist', async () => {
    expect(await readHostConfig(environment)).toEqual({ servers: {}, run: {} })
  })

  it('locates the file through HAMMERKIT_CONFIG, else in the hammerkit directory', () => {
    expect(getHostConfigPath(environment)).toBe(join(dir, 'nested', 'config.yaml'))
    environment.processEnvs = {}
    expect(getHostConfigPath(environment)).toMatch(/hammerkit[\\/]config\.yaml$/)
  })

  it('registers a server and creates the config directory', async () => {
    const server = await addServer(environment, 'mac-mini', 'https://mac-mini.corp/', {
      issuer: 'https://idp.corp/',
    })
    expect(server).toEqual({ url: 'https://mac-mini.corp', issuer: 'https://idp.corp' })
    expect((await readHostConfig(environment)).servers['mac-mini']).toEqual(server)
  })

  it('registering the same server again is idempotent', async () => {
    await addServer(environment, 'a', 'https://a.corp', { issuer: 'https://idp.corp' })
    await addServer(environment, 'a', 'https://a.corp/', { issuer: 'https://idp.corp' })
    expect(Object.keys((await readHostConfig(environment)).servers)).toEqual(['a'])
  })

  it('refuses to repoint a name without --force', async () => {
    await addServer(environment, 'a', 'https://a.corp', { issuer: 'https://idp.corp' })
    await expect(addServer(environment, 'a', 'https://evil.example', { issuer: 'https://idp.corp' })).rejects.toThrow(
      'already registered as https://a.corp'
    )
    await expect(addServer(environment, 'a', 'https://a.corp', { issuer: 'https://other.example' })).rejects.toThrow(
      'already registered'
    )
    await addServer(environment, 'a', 'https://b.corp', { issuer: 'https://idp.corp', force: true })
    expect((await readHostConfig(environment)).servers.a.url).toBe('https://b.corp')
  })

  it('keeps settings it does not know when writing the file back', async () => {
    const path = getHostConfigPath(environment)
    await environment.file.createDirectory(join(path, '..'))
    writeFileSync(path, 'future:\n  setting: 1\nrun:\n  other: true\n')
    await addServer(environment, 'a', 'https://a.corp', { issuer: 'https://idp.corp' })
    const written = readFileSync(path, 'utf8')
    expect(written).toContain('future:')
    expect(written).toContain('other: true')
    expect(written).toContain('https://a.corp')
  })

  it('rejects a config file that does not match the schema, naming the file', async () => {
    const path = getHostConfigPath(environment)
    await environment.file.createDirectory(join(path, '..'))
    writeFileSync(path, 'servers:\n  a:\n    url: https://a.corp\n')
    await expect(readHostConfig(environment)).rejects.toThrow(`invalid ${path}: servers.a.issuer`)
    writeFileSync(path, 'servers: [')
    await expect(readHostConfig(environment)).rejects.toThrow(`unable to read ${path}`)
  })

  it('removes a server and resets the default location that pointed at it', async () => {
    await addServer(environment, 'a', 'https://a.corp', { issuer: 'https://idp.corp' })
    await addServer(environment, 'b', 'https://b.corp', { issuer: 'https://idp.corp' })
    await setDefaultLocation(environment, 'a')
    expect(await removeServer(environment, 'b')).toEqual({ resetDefault: false })
    expect((await readHostConfig(environment)).run.on).toBe('a')
    expect(await removeServer(environment, 'a')).toEqual({ resetDefault: true })
    const config = await readHostConfig(environment)
    expect(config.run.on).toBeUndefined()
    expect(config.servers).toEqual({})
    await expect(removeServer(environment, 'a')).rejects.toThrow('not registered')
  })

  it('sets the default location to local, auto or a registered server only', async () => {
    await setDefaultLocation(environment, 'auto')
    expect((await readHostConfig(environment)).run.on).toBe('auto')
    await setDefaultLocation(environment, 'local')
    expect((await readHostConfig(environment)).run.on).toBe('local')
    await expect(setDefaultLocation(environment, 'unknown')).rejects.toThrow('hammerkit remote add unknown')
    await addServer(environment, 'unknown', 'https://u.corp', { issuer: 'https://idp.corp' })
    await setDefaultLocation(environment, 'unknown')
    expect((await readHostConfig(environment)).run.on).toBe('unknown')
  })

  describe('validateServerName', () => {
    it.each(['a', 'mac-mini', 'corp.k8s', 'Build_1', '0x'])('accepts %s', (name) => {
      expect(validateServerName(name)).toBe(name)
    })

    it.each(['', '-a', '.a', 'a b', 'a/b', '../x', 'a:b'])('rejects "%s"', (name) => {
      expect(() => validateServerName(name)).toThrow('invalid server name')
    })

    it.each(['local', 'auto', 'LOCAL', 'Auto'])('reserves %s', (name) => {
      expect(() => validateServerName(name)).toThrow('reserved')
    })
  })

  describe('normalizeServerUrl', () => {
    it('keeps https urls, with a path, and drops trailing slashes', () => {
      expect(normalizeServerUrl('https://a.corp')).toBe('https://a.corp')
      expect(normalizeServerUrl('https://a.corp/')).toBe('https://a.corp')
      expect(normalizeServerUrl('https://a.corp/hammerkit/')).toBe('https://a.corp/hammerkit')
      expect(normalizeServerUrl('https://a.corp:8443')).toBe('https://a.corp:8443')
    })

    it.each(['http://localhost:8080', 'http://127.0.0.1:8080/', 'http://[::1]:8080'])(
      'allows loopback http %s',
      (url) => {
        expect(normalizeServerUrl(url)).toBe(url.replace(/\/$/, ''))
      }
    )

    it.each([
      ['http://a.corp', 'must use https'],
      ['http://localhost.evil.example', 'must use https'],
      ['ftp://a.corp', 'must use https'],
      ['https://user:pw@a.corp', 'must not contain credentials'],
      ['https://a.corp?x=1', 'must not contain a query or fragment'],
      ['https://a.corp#frag', 'must not contain a query or fragment'],
      ['not a url', 'invalid url'],
      ['', 'invalid url'],
    ])('rejects %s', (url, message) => {
      expect(() => normalizeServerUrl(url)).toThrow(message)
    })

    it('names what was wrong in the message', () => {
      expect(() => normalizeServerUrl('http://a.corp', 'issuer')).toThrow('the issuer must use https')
    })
  })
})
