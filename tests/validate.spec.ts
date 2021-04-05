import {join} from 'path';
import {parseBuildFile} from '../src/parse';
import {getTestArg} from './run-arg';

describe('validate', () => {
  const fileName = join(__dirname, '../examples/validate/build.yaml');
  const buildFile = parseBuildFile(fileName, null);

  function validateTask(name: string, expectedErrors: string[]) {
    const task = buildFile.getTask(name);
    const [arg] = getTestArg();
    const result = Array.from(task.validate(arg));
    expect(result).toHaveLength(expectedErrors.length);
    for (let i = 0; i < expectedErrors.length; i++) {
      expect(result[i].message).toEqual(expectedErrors[i]);
    }
  }

  it('should validate regular task', async () => {
    validateTask('regular_task', []);
  });

  it('should validate task without description', async () => {
    validateTask('missing_desc', ['missing description']);
  });

  it('should detect empty tasks', async () => {
    validateTask('empty', ['task is empty']);
  });

  it('should allow only deps', async () => {
    validateTask('only_deps', []);
  });

  it('should detect loop in cmd', async () => {
    validateTask('loop_with_cmd', ['cycle detected loop_with_cmd -> loop_with_cmd']);
  });

  it('should detect loop in dep', async () => {
    validateTask('loop_with_dep', ['cycle detected loop_with_dep -> loop_with_dep']);
  });

  it('should detect loop in refs', async () => {
    validateTask('loop_with_refs', ['cycle detected loop_with_refs -> loop_with_refs']);
  });

  it('should detect loop over multiple tasks', async () => {
    validateTask('loop_with_multiple_tasks', ['cycle detected loop_with_multiple_tasks -> loop_with_multiple_tasks_2']);
  });

});
