import {join, dirname} from 'path';
import {parseBuildFile} from '../src/parse';
import {getTestArg} from './run-arg';
import {existsSync} from 'fs';
import {remove} from '../src/remove';

describe('clean', () => {
  it('should clean created outputs', async () => {
    const fileName = join(__dirname, '../examples/clean/build.yaml');
    const buildFile = parseBuildFile(fileName, null);
    const outputPath = join(dirname(fileName), 'node_modules');
    const [arg] = getTestArg();

    await remove(outputPath)

    await buildFile.getTask('example').execute(arg);
    expect(existsSync(outputPath)).toBeTruthy();
    await buildFile.clean();
    expect(existsSync(outputPath)).toBeFalsy();
  });
});
