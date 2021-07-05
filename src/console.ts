import colors from 'colors'
import {clearScreenDown, createInterface, CursorPos, cursorTo, Interface, moveCursor} from 'readline';
import {sleep} from './sleep';

let i = 0

async function main() {
  process.stdout.write('\x1B[?25l')
  // process.on('SIGINT', function () {
  //   process.stdout.write('\x1B[?25h')
  //   process.exit(0)
  // })

  const rows = process.stdout.rows - 2;

  for (let i = 0; i < 10; i++) {
    for(let r = 0; r < rows;r++) {
      process.stdout.write(`foo${r} [${i}]\n`);
    }
    moveCursor(process.stdout, 0, -1 * rows);
    await sleep(100);
  }
  process.stdout.write('end' + ' '.repeat(process.stdout.columns-3) + '\n')

  process.stdout.write('\x1B[?25h')
}

function printRight(text: string) {
  console.log(' '.repeat(process.stdout.columns-text.length) + text)
}

function render(rl: Interface, startCol: number, startRow: number) {
  moveCursor(process.stdout, 0, -1 * (process.stdout.rows - 1))
  clearScreenDown(process.stdout)

  process.stdout.write(`${i} :${colors.white('Workers')}\n`)
  for(let r = 0; r < process.stdout.rows-4;r++) {
    process.stdout.write('\n');
  }
  //printRight(`checksum :${colors.white('Cache method')}`)
  //console.log('Watch: disabled' + process.stdout.columns)
  //console.log('Containers: disabled')

  setTimeout(() => {
    i++;
    render(rl, startCol, startRow);
  }, 100)
}

main();
