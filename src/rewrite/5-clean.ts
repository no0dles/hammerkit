import {remove} from '../file/remove';
import {TreeNodes} from './1-plan';

export async function clean(tree: TreeNodes) {
  for(const key of Object.keys(tree)) {
    const node = tree[key]
    for(const generate of node.generates) {
      await remove(generate)
    }
  }
}
