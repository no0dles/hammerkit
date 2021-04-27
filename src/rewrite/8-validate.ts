import {TreeNodes} from './1-plan';
import {BuildFileValidation} from '../build-file-validation';
import {existsSync} from 'fs';

export function* validate(tree: TreeNodes): Generator<BuildFileValidation> {
  for(const key of Object.keys(tree)) {
    const node = tree[key]
    if (!node.description) {
      yield { type: 'warn', message: `missing description`, task: node }
    }

    for (const src of node.src) {
      if (!existsSync(src.absolutePath)) {
        yield {
          type: 'warn',
          message: `src ${src.absolutePath} does not exist`,
          task: node,
        }
      }
    }
  }
}
