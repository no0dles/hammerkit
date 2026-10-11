// What a client needs to know about a server before it signs in. Kept apart from
// the server so the client does not load the http server and token code.
// Bumped when a client could no longer talk to an older or newer server.
export const SERVER_PROTOCOL = 1
export const DISCOVERY_PATH = '/.well-known/hammerkit'

export interface DiscoveredIssuer {
  issuer: string
  audience: string
  clientId?: string
  scope: string
}

export interface DiscoveryDocument {
  name: 'hammerkit'
  version: string
  protocol: number
  // OAuth issuers whose tokens the server accepts, and how a client signs in
  // to them: public OIDC metadata that `remote add` compares with the issuer
  // given on the command line
  issuers: DiscoveredIssuer[]
  backend: { type: 'host'; platform: { os: string; arch: string } }
}
