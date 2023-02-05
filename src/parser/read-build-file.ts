import { parse as yamlParse, stringify as yamlSerialize } from 'yaml'
import { Environment } from '../executer/environment'

export async function write(filename: string, content: any, context: Environment): Promise<void> {
  await context.file.writeFile(filename, yamlSerialize(content))
}

export async function read(fileName: string, context: Environment): Promise<any> {
  context.status
    .context({ type: 'cli', id: 'general', name: 'hammerkit' })
    .write('debug', `read ${fileName} build file`)
  let content: string
  try {
    content = await context.file.read(fileName)
  } catch (e) {
    throw new Error(`unable to read ${fileName}`)
  }
  try {
    return yamlParse(content)
  } catch (e) {
    if (e instanceof Error) {
      throw new Error(`unable to parse ${fileName}: ${e.message}`)
    } else {
      throw e
    }
  }
}
