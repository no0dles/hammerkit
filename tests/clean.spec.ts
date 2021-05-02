import {join} from 'path';
import {getTestArg, loadExampleBuildFile} from './run-arg';
import {existsSync} from 'fs';
import {remove} from '../src/file/remove';
import {executeTask} from '../src/rewrite/4-execute';
import {nodes} from '../src/rewrite/1-plan';
import {clean} from '../src/rewrite/5-clean';

describe('clean', () => {
  it('should clean ccd ex reated outputs', async () => {
    const buildFile = loadExampleBuildFile('clean');
    const outputPath = join(buildFile.path, 'node_modules');
    await remove(outputPath);

    const [arg] = getTestArg();
    const result = await executeTask(buildFile, 'example', false, arg);
    expect(result.success).toBeTruthy();
    expect(existsSync(outputPath)).toBeTruthy();

    await clean(buildFile);
    expect(existsSync(outputPath)).toBeFalsy();
  });
});
