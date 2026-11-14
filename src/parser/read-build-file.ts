import { parse as yamlParse, stringify as yamlSerialize } from 'yaml'
import { Environment } from '../executer/environment'

export async function write(filename: string, content: any, context: Environment): Promise<void> {
  await context.file.writeFile(filename, yamlSerialize(content))
}

export async function read(fileName: string, context: Environment): Promise<any> {
  return (await readSized(fileName, context)).value
}

// The parsed file and the bytes it took.
export async function readSized(fileName: string, context: Environment): Promise<{ value: any; bytes: number }> {
  context.status.context({ type: 'cli', name: 'hammerkit' }).write('debug', `read ${fileName} build file`)
  let content: string
  try {
    content = await context.file.read(fileName)
  } catch (e) {
    throw new Error(`unable to read ${fileName}`)
  }
  try {
    return { value: yamlParse(content), bytes: Buffer.byteLength(content, 'utf8') }
  } catch (e) {
    if (e instanceof Error) {
      throw new Error(`unable to parse ${fileName}: ${e.message}`)
    } else {
      throw e
    }
  }
}
