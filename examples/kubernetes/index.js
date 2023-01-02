const { Pool } = require('pg')
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
  console.log(`Server is running on http://0.0.0.0:3000`)
})
