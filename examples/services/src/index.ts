import { getClient } from '@daita/relational'
import { adapter } from '@daita/pg-adapter'
import { now } from '@daita/relational/sql/function/date/now/now'

async function main() {
  const client = getClient(adapter, {
    connectionString: 'postgres://api:123456@postgres:5432/api',
  })
  const result = await client.selectFirst({
    select: now(),
  })
  console.log(result)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
