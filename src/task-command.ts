import { Task } from './task'

export type TaskCommand = string | TaskCommandRef | TaskCommandCmd

export interface TaskCommandRef {
  task: Task
}

export interface TaskCommandCmd {
  cmd: string
  path?: string
}

export const isTaskCommandConfigCmd = (cmd: TaskCommand): cmd is TaskCommandCmd => !!(<any>cmd).cmd
export const isTaskCommandConfigRef = (cmd: TaskCommand): cmd is TaskCommandRef => !!(<any>cmd).task
