import { environmentMock } from '../executer/environment-mock'
import { Environment } from '../executer/environment'
import { SecretProviderBinding, registerSecretProvider } from './secret-provider'
import { beginSecretRun, fetchProviderValue, peekProviderValue } from './provider-values'

// a provider that counts its calls and answers with the call number
let calls: string[] = []
registerSecretProvider('counting', () => ({
  async resolve(ref) {
    calls.push(ref)
    return `${ref}#${calls.length}`
  },
}))

function binding(provider: string, account: string): SecretProviderBinding {
  return {
    definition: {
      name: provider,
      type: 'counting' as 'command',
      command: [],
      env: {},
      timeoutMs: 1000,
      declaredIn: '',
    },
    account: { name: account, env: {} },
  }
}

describe('provider values', () => {
  let environment: Environment
  beforeEach(() => {
    calls = []
    environment = environmentMock('/tmp')
  })

  it('shares one fetch between concurrent requests for the same provider, account and reference', async () => {
    const values = await Promise.all([
      fetchProviderValue(binding('p', 'a'), 'db', environment),
      fetchProviderValue(binding('p', 'a'), 'db', environment),
    ])
    expect(values).toEqual(['db#1', 'db#1'])
    expect(calls).toEqual(['db'])
  })

  it('keeps providers, accounts and references apart', async () => {
    // joined without a separator these would be the same key
    await fetchProviderValue(binding('p', 'ab'), 'c', environment)
    await fetchProviderValue(binding('p', 'a'), 'bc', environment)
    await fetchProviderValue(binding('pa', 'b'), 'c', environment)
    expect(calls).toEqual(['c', 'bc', 'c'])
  })

  it('keeps the values of one environment out of another', async () => {
    await fetchProviderValue(binding('p', 'a'), 'db', environment)
    await fetchProviderValue(binding('p', 'a'), 'db', environmentMock('/tmp'))
    expect(calls).toEqual(['db', 'db'])
  })

  it('fetches again once the next run begins', async () => {
    await fetchProviderValue(binding('p', 'a'), 'db', environment)
    beginSecretRun(environment)
    expect(await fetchProviderValue(binding('p', 'a'), 'db', environment)).toEqual('db#2')
  })

  it('has a value to peek at only after its fetch finished in this run', async () => {
    expect(peekProviderValue(binding('p', 'a'), 'db', environment)).toBeUndefined()
    const pending = fetchProviderValue(binding('p', 'a'), 'db', environment)
    expect(peekProviderValue(binding('p', 'a'), 'db', environment)).toBeUndefined()
    await pending
    expect(peekProviderValue(binding('p', 'a'), 'db', environment)).toEqual('db#1')
    beginSecretRun(environment)
    expect(peekProviderValue(binding('p', 'a'), 'db', environment)).toBeUndefined()
  })

  it('logs which provider and account read a reference, never the value', async () => {
    const messages: unknown[] = []
    environment.status.on((message) => {
      messages.push({
        level: 'level' in message ? message.level : null,
        message: message.message,
        context: message.context,
      })
    })
    await fetchProviderValue(binding('gsm', 'test'), 'db', environment)
    expect(messages).toEqual([
      { level: 'debug', message: 'secret db via gsm/test', context: { type: 'cli', name: 'hammerkit' } },
    ])
  })
})
