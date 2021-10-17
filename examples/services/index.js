const { Client } = require('pg')

async function main() {
  const client = new Client('postgres://api:123456@postgres:5432/api')
  await client.connect()
  const res = await client.query('SELECT $1::text as message', ['Hello world!'])
  console.log(res.rows[0].message) // Hello world!
  await client.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
