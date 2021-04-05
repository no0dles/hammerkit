import {join, dirname} from 'path';
import {getTestArg} from './run-arg';
import {parseBuildFile} from '../src/parse';
import {appendFileSync, existsSync} from 'fs';
import {remove} from '../src/remove';

describe('cache', () => {
  const fileName = join(__dirname, '../examples/cache/build.yaml');
  const buildFile = parseBuildFile(fileName, null);
  const cachePath = join(dirname(fileName), '.hammerkit')
  const sourceFile = join(dirname(fileName), 'package.json')

  beforeEach(async () => {
    if (existsSync(cachePath)) {
      await remove(cachePath)
    }
  });

  it('should run task only if not cached', async () => {
    const exampleTask = buildFile.getTask('example');
    const [arg] = getTestArg();
    expect(await exampleTask.isCached()).toBeFalsy();
    await exampleTask.execute(arg);
    expect(await exampleTask.isCached()).toBeTruthy();
    await exampleTask.execute(arg);
    appendFileSync(sourceFile, '\n')
    expect(await exampleTask.isCached()).toBeFalsy();
  });

});
