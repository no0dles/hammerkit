export type TaskCommandConfig = string | TaskCommandConfigRef | TaskCommandConfigCmd

export interface TaskCommandConfigCmd {
  cmd: string
  path?: string
}
export interface TaskCommandConfigRef {
  task: string
}
export const isTaskCommandConfigCmd = (cmd: TaskCommandConfig): cmd is TaskCommandConfigCmd => !!(<any>cmd).cmd
