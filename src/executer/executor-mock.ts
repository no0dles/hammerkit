// import { WorkNode } from '../planner/work-node'
// import { listenOnAbort } from '../utils/abort-event'
//
// export interface ExecutorMock extends Executor {
//   waitForExecution(nodeId: string): Promise<NodeHandle>
//
//   abort(nodeId: string, err: Error): void
//
//   end(nodeId: string): void
// }
//
// export interface NodeHandle {
//   fail(err: Error): void
//
//   end(): void
// }
//
// export function getExecutorMock(): ExecutorMock {
//   const waits: { [key: string]: (handle: NodeHandle) => void } = {}
//   const execs: { [key: string]: NodeHandle } = {}
//
//   return {
//     start(): ServiceProcess {
//       return {
//         name: 'mock',
//         async stop(): Promise<void> {
//           return Promise.resolve()
//         }, // TODO
//       }
//     },
//     restore(): Promise<void> {
//       return Promise.resolve()
//     },
//     store(): Promise<void> {
//       return Promise.resolve()
//     },
//     clean(): Promise<void> {
//       return Promise.resolve()
//     },
//     prepareRun(): Promise<void> {
//       return Promise.resolve()
//     },
//     exec(node: WorkNode, context: ExecutionContext, abortCtrl: AbortController): Promise<void> {
//       return new Promise<void>((resolve, reject) => {
//         const handle: NodeHandle = {
//           end() {
//             delete execs[node.id]
//             resolve()
//           },
//           fail(err: Error) {
//             delete execs[node.id]
//             reject(err)
//           },
//         }
//         listenOnAbort(abortCtrl.signal, () => {
//           reject(new Error('canceled'))
//         })
//         if (waits[node.id]) {
//           waits[node.id](handle)
//           delete waits[node.id]
//         } else {
//           execs[node.id] = handle
//         }
//       })
//     },
//     abort(nodeId: string, err: Error): void {
//       execs[nodeId].fail(err)
//     },
//     end(nodeId: string): void {
//       execs[nodeId].end()
//     },
//     async waitForExecution(nodeId: string): Promise<NodeHandle> {
//       const currentExecs = execs[nodeId]
//       if (currentExecs) {
//         return currentExecs
//       }
//
//       return new Promise<NodeHandle>((resolve) => {
//         waits[nodeId] = resolve
//       })
//     },
//   }
// }
