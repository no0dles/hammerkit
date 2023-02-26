export interface DependencyState {
  total: number
  completed: number
  dependencies: DependenciesState
}

export interface DependenciesState {
  [key: string]: { stateKey: string; completed: true } | { completed: false }
}
