import {getTestArg, loadExampleBuildFile} from './run-arg';
import {executeTask} from '../src/rewrite/4-execute';
import {clean} from '../src/rewrite/5-clean';
import {existsSync} from 'fs';
import {join} from 'path';

describe('monorepo', () => {
  const buildFile = loadExampleBuildFile('monorepo');

  it('should build monorepo', async () => {
    const [arg] = getTestArg();
    await executeTask(buildFile, 'build', true, arg);
  });

  it('should clean monorepo', async () => {
    const files = [
      join(buildFile.path, '.hammerkit'),
      join(buildFile.path, 'projects/a/.hammerkit'),
      join(buildFile.path, 'projects/a/node_modules'),
      join(buildFile.path, 'projects/a/dist'),
      join(buildFile.path, 'projects/b/.hammerkit'),
      join(buildFile.path, 'projects/b/node_modules'),
      join(buildFile.path, 'projects/b/dist'),
    ];
    const [arg] = getTestArg();
    await executeTask(buildFile, 'build', false, arg);
    for (const file of files) {
      expect(existsSync(file)).toBeTruthy();
    }
    await clean(buildFile);
    for (const file of files) {
      expect(existsSync(file)).toBeFalsy();
    }
  });
});
