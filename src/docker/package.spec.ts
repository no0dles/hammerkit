import { createTestCase } from '../testing/test-case'

describe('docker/package', () => {
  it('should package', async () => {
    const testCase = createTestCase('package', {
      '.hammerkit.yaml': {
        tasks: {
          install: {
            image: 'node:20-alpine',
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
              POSTGRES_PASSWORD: '$POSTGRES_PASSWORD',
            },
            ports: ['5432'],
            volumes: ['postgres-db:/var/lib/postgresql/data'],
          },
          api: {
            deps: ['install'],
            needs: ['postgres'],
            image: 'node:20-alpine',
            envs: {
              DATABASE_URL: '$DATABASE_URL',
            },
            cmd: 'node index.js',
            src: ['index.js'],
            ports: ['3000'],
          },
        },
      },
      'package.json': '{ "dependencies": { "pg": "^8.7.1" } }',
      '.env': `POSTGRES_PASSWORD=123456
DATABASE_URL=postgres://postgres:123456@postgres/demo`,
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
      await cli.package({ registry: 'registry', push: false, overrideUser: true })
    })
  })
})