const { Client } = require('pg')
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
