const { Client } = require('pg')
const config = require('./config.json')

// the password is in PGPASSWORD, a secret of the build file

async function main() {
  const client = new Client(`postgres://${config.dbUser}@${config.dbHost}:5432/${config.dbName}`)
  await client.connect()
  const res = await client.query('SELECT $1::text as message', ['Hello world!'])
  console.log(res.rows[0].message) // Hello world!
  await client.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
