import {join, relative} from 'path';
import {remove} from '../file/remove';
import {existsSync} from 'fs';
import {copy} from '../file/copy';
import {TreeNodes} from './1-plan';

export async function store(tree: TreeNodes, cwd: string, targetDirectory: string) {
  for(const key of Object.keys(tree)) {
    const node = tree[key]
    for(const sourcePath of node.generates) {
      const relativePath = relative(cwd, sourcePath)
      const targetPath = join(targetDirectory, relativePath)

      await remove(targetPath)

      if (!existsSync(sourcePath)) {
        continue
      }

      copy(sourcePath, targetPath)
    }
  }
}
