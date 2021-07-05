import {WorkTree} from './planner/work-tree';
import {moveCursor} from 'readline';
import {Writable} from 'stream';
import {Defer} from './defer';

export function getLogs(chunk: Buffer | string): string[] {
  return chunk
    .toString()
    .split(/\r?\n/)
    .filter((s) => !!s)
}

export function startWorkTreeLogger(workTree: WorkTree) {
  const defer = new Defer<void>()

  function updateWorkTreeStatus() {
    writeWorkTreeStatus(workTree)
    setTimeout(() => updateWorkTreeStatus(), 100);
  }

  updateWorkTreeStatus();

  return {
    close: () => {
      if (!defer.isResolved) {
        defer.resolve()
      }
      return defer.promise
    }
  }
}


export function writeWorkTreeStatus(workTree: WorkTree) {
  const maxCount = process.stdout.rows - 2;
  const nodeKeys = Object.keys(workTree.nodes);

  let count = 0;
  for(const nodeId of nodeKeys) {
    const node = workTree.nodes[nodeId]
    const completedDepCount = Object.keys(node.status.completedDependencies).length
    const totalDepCount = completedDepCount + Object.keys(node.status.pendingDependencies).length
    process.stdout.write(`${node.name} (${completedDepCount}/${totalDepCount}) - ${node.status.state.type}\n`);
    count++
  }

  moveCursor(process.stdout, 0, -1 * count);
}

export function writeLog(stream: Writable, type: 'debug' | 'info' | 'warn' | 'error', message: string) {
  stream.write(`${type}: ${message}\n`);
}

export function hideCursor() {
  process.stdout.write('\x1B[?25l')
}

export function showCursor() {
  process.stdout.write('\x1B[?25h')
}
