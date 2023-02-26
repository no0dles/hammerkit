export interface DependencyState {
  total: number
  completed: number
  dependencies: DependenciesState
}

export interface DependenciesState {
  [key: string]: { stateKey: string; completed: true } | { completed: false }
}

// export function createDependencyState(item: WorkItem<WorkNode | WorkService>): WorkState<DependencyState> {
//   return mergeStates(
//     item.deps.map((d) => d.data.state),
//     (states) => {
//       return {
//         total: states.length,
//         completed: states.filter((s) => s.type === 'completed').length,
//         dependencies: states.reduce<DependenciesState>((map, state) => {
//           map[state.node.name] =
//             state.type === 'completed' ? { completed: true, stateKey: state.stateKey } : { completed: false }
//           return map
//         }, {}),
//       }
//     }
//   )
// }
