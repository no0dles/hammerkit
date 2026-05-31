const { Client } = require('pg')
const { createServer } = require('http')
const config = require('./config.json')

const client = new Client(`postgres://${config.dbUser}:${config.dbPassword}@${config.dbHost}:5432/${config.dbName}`)

const server = createServer(async (req, res) => {
  const result = await client.query('SELECT $1::text as message', ['Hello world a!'])
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
