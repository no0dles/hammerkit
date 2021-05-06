import { Duplex, Writable } from 'stream'
import { getLogs } from '../log'
import { RunArg } from '../run-arg'
import Dockerode from 'dockerode'

class NoopStream extends Writable {
  constructor(private fn: (log: string) => void) {
    super()
  }

  _write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    for (const log of getLogs(chunk)) {
      this.fn(log.endsWith('\n') ? log.substr(0, log.length - 1) : log)
    }
    setImmediate(callback)
  }
}

export async function awaitStream(docker: Dockerode, stream: Duplex, runArg: RunArg, cmdName: string): Promise<void> {
  docker.modem.demuxStream(
    stream,
    new NoopStream((log) => {
      runArg.logger.withTag(cmdName).info(log)
    }),
    new NoopStream((log) => {
      runArg.logger.withTag(cmdName).info(log)
    })
  )
  await new Promise<void>((resolve, reject) => {
    stream.on('error', (err) => {
      reject(err)
    })
    stream.on('end', () => {
      resolve()
    })
    stream.on('close', () => {
      resolve()
    })
  })
}
