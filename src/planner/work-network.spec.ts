import { limitNetwork, matchesHost, parseNetworkOption, parseWorkNetwork, WorkNetwork } from './work-network'

const none: WorkNetwork = { type: 'none' }
const open: WorkNetwork = { type: 'open' }
const allow = (...hosts: string[]): WorkNetwork => ({ type: 'allow', hosts })

describe('work network', () => {
  it('parses the build file levels, open by default', () => {
    expect(parseWorkNetwork(undefined)).toEqual(open)
    expect(parseWorkNetwork('open')).toEqual(open)
    expect(parseWorkNetwork('none')).toEqual(none)
    expect(parseWorkNetwork({ allow: ['Registry.npmjs.org', 'a.com', 'a.com'] })).toEqual(
      allow('a.com', 'registry.npmjs.org')
    )
  })

  it('parses --network', () => {
    expect(parseNetworkOption('none')).toEqual(none)
    expect(parseNetworkOption('open')).toEqual(open)
    expect(parseNetworkOption('allow:registry.npmjs.org, *.github.com')).toEqual(
      allow('*.github.com', 'registry.npmjs.org')
    )
    expect(parseNetworkOption('allow:')).toEqual(allow())
    expect(() => parseNetworkOption('closed')).toThrow('invalid network "closed", expected none, open or allow')
    expect(() => parseNetworkOption('allow:a.com:443')).toThrow('invalid host "a.com:443"')
    expect(() => parseNetworkOption('allow:10.0.0.1')).toThrow('invalid host "10.0.0.1"')
  })

  it('refuses names a resolver reads as an address', () => {
    for (const host of ['0x7f000001', '0x7f.1', '127.1', '0xa9fea9fe', '*.0x7f.1', 'a.b.123']) {
      expect(() => parseNetworkOption(`allow:${host}`)).toThrow(`invalid host "${host}"`)
    }
    expect(parseNetworkOption('allow:0xide.dev,1password.com,x0.io')).toEqual(
      allow('0xide.dev', '1password.com', 'x0.io')
    )
  })

  it('matches a name or the names under a wildcard domain', () => {
    expect(matchesHost('registry.npmjs.org', 'registry.npmjs.org')).toBe(true)
    expect(matchesHost('registry.npmjs.org', 'REGISTRY.npmjs.org.')).toBe(true)
    expect(matchesHost('registry.npmjs.org', 'npmjs.org')).toBe(false)
    expect(matchesHost('*.github.com', 'api.github.com')).toBe(true)
    expect(matchesHost('*.github.com', 'a.b.github.com')).toBe(true)
    expect(matchesHost('*.github.com', 'github.com')).toBe(false)
    expect(matchesHost('*.github.com', 'evilgithub.com')).toBe(false)
  })

  describe('under a ceiling', () => {
    it.each<[string, WorkNetwork, WorkNetwork | null, WorkNetwork]>([
      ['no ceiling', open, null, open],
      ['an open ceiling', allow('a.com'), open, allow('a.com')],
      ['none clamps open', open, none, none],
      ['none clamps allow', allow('a.com'), none, none],
      ['none stays none under allow', none, allow('a.com'), none],
      ['open becomes the allow ceiling', open, allow('a.com'), allow('a.com')],
      ['allow keeps the hosts both allow', allow('a.com', 'b.com'), allow('b.com', 'c.com'), allow('b.com')],
      ['a name within a wildcard ceiling', allow('api.github.com'), allow('*.github.com'), allow('api.github.com')],
      ['a wildcard cut to a name', allow('*.github.com'), allow('api.github.com'), allow('api.github.com')],
      ['a wildcard within a wider one', allow('*.a.github.com'), allow('*.github.com'), allow('*.a.github.com')],
      ['nothing in common', allow('a.com'), allow('b.com'), allow()],
    ])('%s', (_, network, ceiling, expected) => {
      expect(limitNetwork(network, ceiling)).toEqual(expected)
    })
  })
})
