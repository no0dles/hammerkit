import { SandboxClient } from './sandbox-client'
import { SERVICE_TOOLS } from './service-tools'

const endpointGet = SERVICE_TOOLS.find((tool) => tool.name === 'endpoint_get')!

function clientAnswering(body: string, truncated: boolean): SandboxClient {
  return {
    fetchEndpoint: async () => ({ url: 'https://web.example/', status: 200, type: 'text/html', body, truncated }),
  } as unknown as SandboxClient
}

describe('endpoint_get', () => {
  const signal = new AbortController().signal

  it('answers a short page in full', async () => {
    expect(await endpointGet.call(clientAnswering('<h1>hi</h1>', false), { run: 'run_1', path: '/' }, signal)).toBe(
      'GET https://web.example/: 200 (text/html)\n\n<h1>hi</h1>'
    )
  })

  it('shows the start of a long page and says that there was more', async () => {
    const long = await endpointGet.call(clientAnswering('x'.repeat(30_000), false), { run: 'r', path: '/' }, signal)
    expect(long).toContain('… (30000 characters, the first 20000 shown)')
    const cut = await endpointGet.call(clientAnswering('x'.repeat(30_000), true), { run: 'r', path: '/' }, signal)
    expect(cut).toContain('… (more than 30000 characters, the first 20000 shown)')
    const short = await endpointGet.call(clientAnswering('x'.repeat(10), true), { run: 'r', path: '/' }, signal)
    expect(short).toContain('… (more than 10 characters, the first 10 shown)')
  })
})
