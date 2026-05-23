import { requiresKubernetes } from '../requires-kubernetes'
import { createTestCase } from '../test-case'

describe('kubernetes', () => {
  const suite = createTestCase('kubernetes', {
    '.hammerkit.yaml': {
      services: {
        postgres: {
          image: 'postgres:12-alpine',
          envs: {
            POSTGRES_USER: 'postgres',
            POSTGRES_DB: 'demo',
            POSTGRES_PASSWORD: '123456',
          },
          volumes: ['data:/var/lib/postgresql/data'],
          ports: ['5432:5432'],
        },
        api: {
          image: 'node:16.6.0-alpine',
          deps: ['install'],
          needs: ['postgres'],
          ports: [3000],
          labels: {
            app: 'example',
          },
          src: ['index.js'],
          cmd: 'node index.js',
        },
      },
      tasks: {
        install: {
          image: 'node:16.6.0-alpine',
          src: ['package.json'],
          generates: ['node_modules'],
          cmds: ['npm install'],
        },
      },
      environments: {
        default: {
          kubernetes: {
            namespace: 'default',
            context: process.env.CLUSTER_NAME || 'docker-desktop',
          },
        },
      },
    },
    'index.js': `const { Pool } = require('pg')
const { createServer } = require('http')

const pool = new Pool({
  connectionString: 'postgres://api:123456@postgres:5432/api',
})

pool.on('error', () => {
  console.error('pool has connection error')
})

const server = createServer(async function (req, res) {
  let client
  try {
    client = await pool.connect()
    const queryResult = await client.query('SELECT $1::text as message', ['Hello world from PG!'])

    res.writeHead(200)
    res.end(queryResult.rows[0].message)
  } catch (e) {
    res.writeHead(500)
    res.end(e.message)
  } finally {
    client?.release()
  }
})

process.on('SIGINT', async function () {
  server.close()
  await pool.end()
})

server.listen(3000, () => {
  console.log(\`Server is running on http://0.0.0.0:3000\`)
})
`,
    'package.json': `{
  "name": "example-with-service",
  "version": "1.0.0",
  "dependencies": {
    "pg": "^8.7.1"
  }
}
`,
  })

  it(
    'should create deployment',
    requiresKubernetes(async () => {
      await suite.cli({}, async (cli) => {
        await cli.runUp({ daemon: true })
      })
    })
  )
})
