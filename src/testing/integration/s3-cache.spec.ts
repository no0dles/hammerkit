import Dockerode from 'dockerode'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Stream } from 'stream'
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3'
import { createS3CacheBackend } from '../../cache/backends/s3-cache-backend'
import { environmentMock } from '../../executer/environment-mock'
import { requiresLinuxContainers } from '../requires-linux-containers'

// The s3 cache backend against a real S3 API (VersityGW, an S3 gateway over a
// local directory — MinIO no longer publishes public images): push, pull, list
// and remove, including retention metadata.

const ACCESS_KEY = 'hammerkit'
const SECRET_KEY = 'hammerkit-secret'
const BUCKET = 'hammerkit-cache'

async function ensureImage(docker: Dockerode, image: string): Promise<void> {
  try {
    await docker.getImage(image).inspect()
    return
  } catch {
    // pull below
  }
  await new Promise<void>((resolve, reject) => {
    docker.pull(image, (err: unknown, stream: NodeJS.ReadableStream | undefined) => {
      if (err || !stream) {
        reject(err ?? new Error('no pull stream'))
        return
      }
      docker.modem.followProgress(stream as unknown as Stream, (e: unknown) => (e ? reject(e) : resolve()))
    })
  })
}

describe('s3 cache backend (real S3 API)', () => {
  const docker = new Dockerode()
  let container: Dockerode.Container | null = null
  let endpoint = ''
  const previousEnv = { ...process.env }

  beforeAll(
    requiresLinuxContainers(async () => {
      await ensureImage(docker, 'versity/versitygw:latest')
      container = await docker.createContainer({
        Image: 'versity/versitygw:latest',
        Entrypoint: ['sh', '-c'],
        Cmd: [`mkdir -p /tmp/vgw && exec versitygw --access ${ACCESS_KEY} --secret ${SECRET_KEY} posix /tmp/vgw`],
        Labels: { app: 'hammerkit' },
        ExposedPorts: { '7070/tcp': {} },
        HostConfig: { AutoRemove: true, PortBindings: { '7070/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] } },
      })
      await container.start()
      const info = await container.inspect()
      endpoint = `http://127.0.0.1:${info.NetworkSettings.Ports['7070/tcp'][0].HostPort}`
      // the AWS SDK reads credentials from the process environment
      process.env.AWS_ACCESS_KEY_ID = ACCESS_KEY
      process.env.AWS_SECRET_ACCESS_KEY = SECRET_KEY
      const client = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true })
      for (let attempt = 0; ; attempt++) {
        try {
          await client.send(new CreateBucketCommand({ Bucket: BUCKET }))
          break
        } catch (e) {
          if (attempt > 50) throw e
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
      }
    })
  )

  afterAll(async () => {
    process.env.AWS_ACCESS_KEY_ID = previousEnv.AWS_ACCESS_KEY_ID
    process.env.AWS_SECRET_ACCESS_KEY = previousEnv.AWS_SECRET_ACCESS_KEY
    if (container) {
      await container.stop().catch(() => undefined)
    }
  })

  it(
    'round-trips, lists and removes entries',
    requiresLinuxContainers(async () => {
      const scratch = mkdtempSync(join(tmpdir(), 'hammerkit-s3-'))
      try {
        const environment = environmentMock(scratch)
        const backend = createS3CacheBackend({
          type: 's3',
          bucket: BUCKET,
          region: 'us-east-1',
          endpoint,
          prefix: 'ci',
        })
        const from = join(scratch, 'from')
        await environment.file.createDirectory(from)
        await environment.file.writeFile(join(from, 'stats.json'), '{"files":{}}')
        await environment.file.writeFile(join(from, 'out-generates.tgz'), 'x'.repeat(4096))

        expect(await backend.has('task1', 'state1', environment)).toBe(false)
        await backend.push('task1', 'state1', from, environment)
        await backend.push('task1', 'state2', from, environment)
        expect(await backend.has('task1', 'state1', environment)).toBe(true)

        const into = join(scratch, 'into')
        expect(await backend.pull('task1', 'state1', into, environment)).toBe(true)
        expect(await environment.file.read(join(into, 'out-generates.tgz'))).toBe('x'.repeat(4096))

        const entries = await backend.list!(environment)
        expect(entries.map((e) => e.stateKey).sort()).toEqual(['state1', 'state2'])
        expect(entries[0].size).toBe(4096 + '{"files":{}}'.length)
        expect(entries[0].createdAt).toBeGreaterThan(Date.now() - 60_000)

        await backend.remove!('task1', 'state1', environment)
        expect(await backend.has('task1', 'state1', environment)).toBe(false)
        expect((await backend.list!(environment)).map((e) => e.stateKey)).toEqual(['state2'])
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
    })
  )
})
