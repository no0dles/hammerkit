import { remove } from '../file/remove'
import { join } from 'path'
import { existsSync } from 'fs'
import consola from 'consola'
import { BuildFile } from '../parser/build-file'
import { planWorkNodes } from '../planner/utils/plan-work-nodes'

export async function clean(buildFile: BuildFile): Promise<void> {
  const tree = planWorkNodes(buildFile)
  for (const key of Object.keys(tree)) {
    const node = tree[key]
    for (const generate of node.generates) {
      if (existsSync(generate)) {
        consola.info(`remove generate ${generate}`)
        await remove(generate)
      }
    }
    const cachePath = join(node.path, '.hammerkit')
    if (existsSync(cachePath)) {
      consola.info(`remove cache ${cachePath}`)
      await remove(cachePath)
    }
  }
}
