import zodToJsonSchema from 'zod-to-json-schema'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { buildFileSchema } from './schema/build-file-schema'

const jsonSchema = zodToJsonSchema(buildFileSchema, 'hammerkit')
writeFileSync(join(process.cwd(), 'build.schema.gen.json'), JSON.stringify(jsonSchema, null, 2))
