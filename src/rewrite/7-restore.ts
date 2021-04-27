import {join, relative} from 'path';
import {existsSync} from 'fs';
import {copy} from '../file/copy';
import {remove} from '../file/remove';
import {TreeNodes} from './1-plan';

export async function restore(tree: TreeNodes, cwd: string, targetDirectory: string) {
  for (const key of Object.keys(tree)) {
    const node = tree[key];
    for (const targetPath of node.generates) {
      const sourcePath = join(targetDirectory, relative(cwd, targetPath));

      if (!existsSync(sourcePath)) {
        continue;
      }

      if (existsSync(targetPath)) {
        await remove(targetPath);
      }

      copy(sourcePath, targetPath);
    }
  }
}
