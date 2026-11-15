import {
  exceedsNetwork,
  getTcpForwards,
  limitNetwork,
  matchesHost,
  parseNetworkOption,
  parseWorkNetwork,
  WorkNetwork,
} from './work-network'

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
    expect(() => parseNetworkOption('allow:10.0.0.1')).toThrow('invalid host "10.0.0.1"')
  })

  it('takes a name and port for raw TCP to one host', () => {
    expect(parseNetworkOption('allow:db.example.com:5432,cache:6379')).toEqual(
      allow('cache:6379', 'db.example.com:5432')
    )
    expect(getTcpForwards(allow('a.com', 'db.example.com:5432'))).toEqual([{ host: 'db.example.com', port: 5432 }])
    expect(getTcpForwards(none)).toEqual([])
    // one host, a real port, and not the proxy's own
    for (const host of ['*.example.com:5432', 'a.com:0', 'a.com:65536', 'a.com:3128', '10.0.0.1:5432', 'a.com:']) {
      expect(() => parseNetworkOption(`allow:${host}`)).toThrow(`invalid host "${host}"`)
    }
    // the proxy listens on each forward's port
    expect(() => parseNetworkOption('allow:a.com:5432,b.com:5432')).toThrow(
      'a.com:5432 and b.com:5432 share a port, each TCP forward needs its own'
    )
    expect(parseNetworkOption('allow:a.com:5432,A.com:5432')).toEqual(allow('a.com:5432'))
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
      [
        'a name within a wildcard ceiling',
        allow('api.github.com'),
        allow('*.github.com'),
        { type: 'allow', hosts: ['api.github.com'], publicOnly: ['api.github.com'] },
      ],
      [
        'a wildcard cut to a name',
        allow('*.github.com'),
        allow('api.github.com'),
        { type: 'allow', hosts: ['api.github.com'], publicOnly: ['api.github.com'] },
      ],
      ['a wildcard within a wider one', allow('*.a.github.com'), allow('*.github.com'), allow('*.a.github.com')],
      ['nothing in common', allow('a.com'), allow('b.com'), allow()],
      ['a forward within its host', allow('db.a.com:5432'), allow('db.a.com'), allow('db.a.com:5432')],
      [
        'a forward within a wildcard',
        allow('db.a.com:5432'),
        allow('*.a.com'),
        { type: 'allow', hosts: ['db.a.com:5432'], publicOnly: ['db.a.com:5432'] },
      ],
      ['a host cut to a forward', allow('db.a.com'), allow('db.a.com:5432'), allow('db.a.com:5432')],
      ['a forward on another port', allow('db.a.com:5432'), allow('db.a.com:6432'), allow()],
      ['a forward to another host', allow('db.a.com:5432'), allow('db.b.com:5432'), allow()],
    ])('%s', (_, network, ceiling, expected) => {
      expect(limitNetwork(network, ceiling)).toEqual(expected)
    })

    // a name reaches private addresses, a pattern doesn't: a name that one
    // list allows only through a pattern doesn't either
    it.each<[string, WorkNetwork, WorkNetwork, string[] | undefined]>([
      ['a forward within a wildcard ceiling', allow('db.corp.com:5432'), allow('*.corp.com'), ['db.corp.com:5432']],
      ['a name within a wildcard ceiling', allow('vault.corp.com'), allow('*.corp.com'), ['vault.corp.com']],
      ['a ceiling name within a wildcard', allow('*.corp.com'), allow('vault.corp.com'), ['vault.corp.com']],
      ['a forward within its host by name', allow('db.corp.com:5432'), allow('db.corp.com'), undefined],
      ['a name in both lists', allow('db.corp.com', '*.corp.com'), allow('db.corp.com'), undefined],
      ['a pattern in both lists', allow('*.corp.com'), allow('*.corp.com'), undefined],
      [
        'a name that was public only stays so',
        { type: 'allow', hosts: ['db.corp.com:5432'], publicOnly: ['db.corp.com:5432'] },
        allow('db.corp.com:5432'),
        ['db.corp.com:5432'],
      ],
    ])('%s', (_, network, ceiling, publicOnly) => {
      const limited = limitNetwork(network, ceiling)
      expect(limited.type === 'allow' ? limited.publicOnly : null).toEqual(publicOnly)
    })
  })

  describe('over a ceiling', () => {
    it.each<[string, WorkNetwork, WorkNetwork, boolean]>([
      ['anything under open', open, open, false],
      ['none under none', none, none, false],
      ['an empty allow list under none', allow(), none, false],
      ['a host under none', allow('a.com'), none, true],
      ['open under allow', open, allow('a.com'), true],
      ['a name within a wildcard', allow('api.github.com'), allow('*.github.com'), false],
      ['a wildcard over a name', allow('*.github.com'), allow('api.github.com'), true],
      ['a forward within its host', allow('db.a.com:5432'), allow('db.a.com'), false],
      ['a forward within a wildcard', allow('db.a.com:5432'), allow('*.a.com'), false],
      ['a forward within the same forward', allow('db.a.com:5432'), allow('db.a.com:5432'), false],
      ['a host over a forward to it', allow('db.a.com'), allow('db.a.com:5432'), true],
      ['a forward on another port', allow('db.a.com:5432'), allow('db.a.com:6432'), true],
    ])('%s', (_, network, ceiling, expected) => {
      expect(exceedsNetwork(network, ceiling)).toBe(expected)
    })
  })
})
