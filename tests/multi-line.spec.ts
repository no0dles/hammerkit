import {getTestArg, loadExampleBuildFile} from './run-arg';

describe('multi-line', () => {
  const buildFile = loadExampleBuildFile('multi-line');

  it('should get multi lines', async () => {
    const exampleTask = buildFile.getTask('example');
    const [arg] = getTestArg();
    const cmds = Array.from(exampleTask.getCommands(arg));
    expect(cmds).toEqual(['some very long cmd continues on line 2', 'some other very long cmd continues on line 2']);
    expect(exampleTask.getDescription()).toEqual('Test multiline description');
  });
});
