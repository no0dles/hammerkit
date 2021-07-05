import {planWorkTree} from '../src/planner/utils/plan-work-tree';
import {execute} from '../src/executer/execute';
import {WorkNode} from '../src/planner/work-node';
import {join} from 'path';
import {getTestSuite} from './run-arg';

describe('watch', () => {
  const suite = getTestSuite('watch', ['build.yaml', 'src', 'package.json', 'package-lock.json', 'tsconfig.json']);

  it('should run watch task and cancel', async () => {
    const {buildFile, context, executionContext} = await suite.setup();

    const apiNodeId = `${buildFile.path}:api`;

    executionContext.watch = true;
    executionContext.events.on(({workTree, nodeId, oldState, newState}) => {
      if (workTree.nodes[apiNodeId].status.state.type === 'running') {
        context.cancelDefer.resolve();
      }
    });
    const workTree = planWorkTree(buildFile, 'api');
    const result = await execute(workTree, executionContext);

    expect(result.success).toBeFalsy();
    expect(result.nodes[apiNodeId].state.type).toEqual('aborted');
  });

  it('should restart task if dependency updates', async () => {
    const {buildFile, context, executionContext} = await suite.setup();

    const apiNodeId = `${buildFile.path}:api`;
    let restarted = false;

    executionContext.watch = true;
    executionContext.events.on(({workTree, nodeId, oldState, newState}) => {
      console.log(nodeId, oldState.type, newState.type)
      if (nodeId === apiNodeId && newState.type === 'running') {
        if (restarted) {
          context.cancelDefer.resolve();
        } else {
          context.file.appendFile(join(buildFile.path, 'package.json'), '\n')
          restarted = true
        }
      }
    });
    const workTree = planWorkTree(buildFile, 'api');
    const result = await execute(workTree, executionContext);

    expect(result.success).toBeFalsy();
    expect(result.nodes[apiNodeId].state.type).toEqual('aborted');

    // const {buildFile, executionContext} = await suite.setup()
    // arg.watch = true;
    //
    // const workTree = planWorkTree(buildFile, 'api');
    // const apiNode = workTree.nodes[`${buildFile.path}:api`];
    // const installNode = workTree.nodes[`${buildFile.path}:install`];
    //
    // waitForState(apiNode, 'running').then(() => {
    //   console.log('api running');
    //   let firstStart = apiNode.status.state.type === 'running' ? apiNode.status.state.started : null;
    //   expect(firstStart).not.toBeNull();
    //
    //   expect(installNode.status.state.type).toEqual('completed')
    //   appendFileSync(join(buildFile.path, 'package.json'), '\n')
    //   setTimeout(() => {
    //     expect(installNode.status.state.type).not.toEqual('completed')
    //     waitForState(installNode, 'completed').then(() => {
    //       console.log('install completed');
    //       waitForState(apiNode, 'running').then(() => {
    //         console.log(apiNode.status.state, firstStart)
    //         arg.cancelPromise.resolve()
    //         done();
    //       })
    //     });
    //   }, 100);
    // });
    // execute(workTree, arg)
  });
});


function waitForState(node: WorkNode, stateType: string): Promise<void> {
  return new Promise<void>((resolve) => {
    if (node.status.state.type === stateType) {
      resolve();
    } else {
      setTimeout(() => {
        waitForState(node, stateType).then(resolve);
      }, 100);
    }
  });
}
