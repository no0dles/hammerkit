import { spawn } from 'child_process'
import { AddressInfo, connect, createServer, Socket } from 'net'
import { getPortRelayEnvironment, PORT_RELAY_SCRIPT } from './port-relay'

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

function request(port: number, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(port, '127.0.0.1', () => socket.end(message))
    let received = ''
    socket.on('data', (data: Buffer) => (received += data.toString()))
    socket.on('end', () => resolve(received))
    socket.on('error', reject)
  })
}

describe('port relay', () => {
  it('passes each connection on to its target', async () => {
    const echo = createServer((socket) => {
      socket.on('data', (data) => socket.end(`echo ${data.toString()}`))
    })
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve))
    const targetPort = (echo.address() as AddressInfo).port
    const port = await freePort()
    const relay = spawn(process.execPath, ['-e', PORT_RELAY_SCRIPT], {
      env: getPortRelayEnvironment([{ port, host: '127.0.0.1', targetPort }]),
      stdio: 'inherit',
    })
    try {
      let response: string | null = null
      for (let attempt = 0; attempt < 100 && response === null; attempt++) {
        response = await request(port, 'hi').catch(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50))
          return null
        })
      }
      expect(response).toBe('echo hi')
    } finally {
      relay.kill()
      await new Promise<void>((resolve) => echo.close(() => resolve()))
    }
  })
})
