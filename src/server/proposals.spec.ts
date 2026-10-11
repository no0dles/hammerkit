import { vi } from 'vitest'
import { Bundle } from '../remote/bundle'
import { DefinitionVersion } from './definitions'
import { ProposalError, ProposalRegistry } from './proposals'

const version = (hash = 'sha256:' + 'a'.repeat(64)): DefinitionVersion => ({
  name: 'payments',
  hash,
  entry: '.hammerkit.yaml',
  publishedAt: new Date().toISOString(),
  publishedBy: { iss: 'https://idp.corp', sub: 'agent' },
  tasks: ['build'],
  services: [],
})
const bundle: Bundle = { entry: '.hammerkit.yaml', files: { '.hammerkit.yaml': 'tasks: {}' } }
const person = (sub: string) => ({ iss: 'https://idp.corp', sub })
const may = (allowed: boolean) => () => allowed

describe('ProposalRegistry', () => {
  it('holds a proposed version and tells what it is', () => {
    const registry = new ProposalRegistry()
    const { proposal, created } = registry.propose(version(), bundle, person('agent'))
    expect(created).toBe(true)
    expect(proposal).toMatchObject({
      name: 'payments',
      state: 'waiting',
      proposedBy: person('agent'),
      tasks: ['build'],
    })
    expect(new Date(proposal.expiresAt).getTime()).toBeGreaterThan(Date.now())
    expect(registry.waiting()).toHaveLength(1)
    expect(registry.get('payments', version().hash)?.state).toBe('waiting')
    expect(registry.bundle('payments', version().hash)).toEqual(bundle)
    registry.close()
  })

  it('does not hold the same version twice', () => {
    const registry = new ProposalRegistry()
    registry.propose(version(), bundle, person('agent'))
    const again = registry.propose(version(), bundle, person('other'))
    expect(again.created).toBe(false)
    expect(again.proposal.proposedBy).toEqual(person('agent'))
    expect(registry.waiting()).toHaveLength(1)
    registry.close()
  })

  it('publishes the files before it calls a proposal approved', async () => {
    const registry = new ProposalRegistry()
    registry.propose(version(), bundle, person('agent'))
    const published: Bundle[] = []
    const result = await registry.decide(
      person('dev'),
      'payments',
      version().hash,
      'approved',
      may(true),
      async (b) => {
        expect(registry.get('payments', version().hash)?.state).toBe('waiting')
        published.push(b)
      }
    )
    expect(result).toMatchObject({ status: 'ok', proposal: { state: 'approved', decidedBy: person('dev') } })
    expect(published).toEqual([bundle])
    expect(registry.waiting()).toEqual([])
    // the files are not kept once it is decided
    expect(registry.bundle('payments', version().hash)).toBeUndefined()
    expect(
      await registry.decide(person('dev'), 'payments', version().hash, 'rejected', may(true), async () => {})
    ).toEqual({
      status: 'not-waiting',
      state: 'approved',
    })
    registry.close()
  })

  it('stays waiting when the files can not be published', async () => {
    const registry = new ProposalRegistry()
    registry.propose(version(), bundle, person('agent'))
    await expect(
      registry.decide(person('dev'), 'payments', version().hash, 'approved', may(true), async () => {
        throw new Error('disk full')
      })
    ).rejects.toThrow('disk full')
    expect(registry.get('payments', version().hash)?.state).toBe('waiting')
    registry.close()
  })

  it('drops a rejected version with the reason', async () => {
    const registry = new ProposalRegistry()
    registry.propose(version(), bundle, person('agent'))
    const publish = vi.fn()
    const result = await registry.decide(
      person('dev'),
      'payments',
      version().hash,
      'rejected',
      may(true),
      publish,
      'no'
    )
    expect(result).toMatchObject({ status: 'ok', proposal: { state: 'rejected', reason: 'no' } })
    expect(publish).not.toHaveBeenCalled()
    // the same version can be proposed again
    expect(registry.propose(version(), bundle, person('agent')).created).toBe(true)
    registry.close()
  })

  it('lets nobody decide on their own proposal, nor without the permission', async () => {
    const registry = new ProposalRegistry()
    registry.propose(version(), bundle, person('agent'))
    const publish = vi.fn()
    expect(await registry.decide(person('agent'), 'payments', version().hash, 'approved', may(true), publish)).toEqual({
      status: 'own-proposal',
    })
    expect(await registry.decide(person('dev'), 'payments', version().hash, 'approved', may(false), publish)).toEqual({
      status: 'not-found',
    })
    expect(
      await registry.decide(person('dev'), 'payments', 'sha256:' + 'b'.repeat(64), 'approved', may(true), publish)
    ).toEqual({
      status: 'not-found',
    })
    expect(publish).not.toHaveBeenCalled()
    expect(registry.get('payments', version().hash)?.state).toBe('waiting')
    registry.close()
  })

  it('expires a proposal nobody decided on', async () => {
    const registry = new ProposalRegistry({ timeout: 20 })
    registry.propose(version(), bundle, person('agent'))
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(registry.get('payments', version().hash)?.state).toBe('expired')
    expect(registry.bundle('payments', version().hash)).toBeUndefined()
    expect(
      await registry.decide(person('dev'), 'payments', version().hash, 'approved', may(true), async () => {})
    ).toMatchObject({
      status: 'not-waiting',
      state: 'expired',
    })
    registry.close()
  })

  it('only holds so many, and forgets the oldest decided ones', async () => {
    const registry = new ProposalRegistry({ maxWaiting: 2, keep: 1 })
    const hash = (c: string) => 'sha256:' + c.repeat(64)
    registry.propose(version(hash('a')), bundle, person('agent'))
    registry.propose(version(hash('b')), bundle, person('agent'))
    expect(() => registry.propose(version(hash('c')), bundle, person('agent'))).toThrow(ProposalError)
    await registry.decide(person('dev'), 'payments', hash('a'), 'rejected', may(true), async () => {})
    registry.propose(version(hash('c')), bundle, person('agent'))
    await registry.decide(person('dev'), 'payments', hash('b'), 'rejected', may(true), async () => {})
    registry.propose(version(hash('d')), bundle, person('agent'))
    expect(registry.get('payments', hash('a'))).toBeUndefined()
    expect(registry.get('payments', hash('b'))?.state).toBe('rejected')
    registry.close()
  })

  it('refuses proposals when it is closed', () => {
    const registry = new ProposalRegistry()
    registry.close()
    expect(() => registry.propose(version(), bundle, person('agent'))).toThrow('shutting down')
  })
})
