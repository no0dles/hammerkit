import { Duplex } from 'stream'
import { getLogs } from '../log'
import Dockerode from 'dockerode'
import { ContainerWorkNode } from '../planner/work-node'
import { WorkNodeConsole, WorkNodeConsoleLogLevel } from '../planner/work-node-status'

export async function awaitStream(console: WorkNodeConsole, docker: Dockerode, stream: Duplex): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    function writeLog(leve: WorkNodeConsoleLogLevel) {
      return (buffer: Buffer) => {
        for (const log of getLogs(buffer)) {
          console.write('process', leve, log.endsWith('\n') ? log.substr(0, log.length - 1) : log)
        }
      }
    }

    stream.on('error', reject)
    stream.on('end', resolve)
    stream.on('close', resolve)

    demuxStream(stream, writeLog('info'), writeLog('error'))
  })
}

function demuxStream(stream: any, stdoutFn: (buffer: Buffer) => void, stderrFn: (buffer: Buffer) => void) {
  let nextDataType: null | number = null
  let nextDataLength: null | number = null
  let buffer = Buffer.from('')

  function processData(data?: Buffer) {
    if (data) {
      buffer = Buffer.concat([buffer, data])
    }
    if (nextDataType && nextDataLength) {
      if (buffer.length >= nextDataLength) {
        const content = bufferSlice(nextDataLength)
        if (nextDataType === 1) {
          stdoutFn(content)
        } else {
          stderrFn(content)
        }
        nextDataType = null
        // It's possible we got a "data" that contains multiple messages
        // Process the next one
        processData()
      }
    } else {
      if (buffer.length >= 8) {
        const header = bufferSlice(8)
        nextDataType = header.readUInt8(0)
        nextDataLength = header.readUInt32BE(4)
        // It's possible we got a "data" that contains multiple messages
        // Process the next one
        processData()
      }
    }
  }

  function bufferSlice(end: number) {
    const out = buffer.slice(0, end)
    buffer = Buffer.from(buffer.slice(end, buffer.length))
    return out
  }

  stream.on('data', processData)
}
