import { environmentMock } from '../executer/environment-mock'
import { parseReferences } from '../schema/reference-parser'
import { getWorkContext } from '../schema/work-scope-parser'
import { BuildFileTaskSchema } from '../schema/build-file-task-schema'
import { WorkItem } from '../planner/work-item'
import { WorkNode } from '../planner/work-node'

export async function getWorkNode(taskSchema: BuildFileTaskSchema): Promise<WorkItem<WorkNode>> {
  const environment = environmentMock(process.cwd())
  const context = await parseReferences(
    {
      files: {
        '/build.yaml': {
          cwd: process.cwd(),
          fileName: '/build.yaml',
          references: {},
          namePrefix: '',
          schema: {
            tasks: {
              test: taskSchema,
            },
          },
        },
      },
    },
    environment
  )
  const workTree = await getWorkContext(context, { taskName: 'test' }, environment)
  return Object.values(workTree.nodes)[0]
}
