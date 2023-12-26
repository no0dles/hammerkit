import { getTestSuite } from '../get-test-suite'
import { createTestCase } from '../test-case'

describe('environment', () => {
  const suite = getTestSuite('error', ['.hammerkit.yaml'])

  afterAll(() => suite.close())

  it('should run on environment', async () => {
    const testCase = createTestCase('environment', {
      '.hammerkit.yaml': {
        tasks: {
          install: {
            image: 'node:18-alpine',
            cmds: ['npm install'],
            src: ['package.json'],
            generates: ['node_modules'],
          },
        },
        services: {
          postgres: {
            image: 'postgres',
            envs: {
              POSTGRES_USER: 'postgres',
              POSTGRES_DB: 'demo',
              POSTGRES_PASSWORD: '123456',
            },
            ports: ['5432'],
            volumes: ['postgres-db:/var/lib/postgresql/data'],
          },
          api: {
            deps: ['install'],
            needs: ['postgres'],
            image: 'node:16.6.0-alpine',
            envs: {
              DATABASE_URL: 'postgres://postgres:123456@postgres/demo',
            },
            cmd: 'node index.js',
            src: ['index.js'],
            ports: ['3000'],
          },
        },
        environments: {
          staging: {
            kubernetes: {
              namespace: 'default',
              context: 'gke_crios-333820_europe-west1-c_crios', // 'popos', //'gke_crios-333820_europe-west1-c_crios',
              //storageClass:  'local-path'
              ingresses: [
                {
                  host: 'demo.bertschi.io',
                  service: 'api',
                },
              ],
            },
          },
        },
      },
      'package.json': '{ "dependencies": { "pg": "^8.7.1" } }',
      'index.js': `const { Client } = require('pg')
const { createServer } = require('http')

const client = new Client(process.env.DATABASE_URL)

const server = createServer(async (req, res) => {
  const result = await client.query('SELECT $1::text as message', ['Hello world!'])
  res.writeHead(200)
  res.end(result.rows[0].message)
})

async function main() {
  await client.connect()
  server.listen(3000)
}

process.on('SIGINT', async function () {
  server.close()
  await client.end()
})

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
`,
    })
    await testCase.cli({ environmentName: 'staging' }, async (cli) => {
      await cli.runUp({ daemon: true })
    })
  })
})
