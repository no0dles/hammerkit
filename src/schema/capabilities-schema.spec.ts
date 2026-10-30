import { buildFileSchema } from './build-file-schema'
import { buildFileContainerTaskSchema } from './build-file-container-task-schema'

describe('capAdd of a container task', () => {
  function messages(capAdd: unknown): string[] {
    const result = buildFileContainerTaskSchema.safeParse({ image: 'moby/buildkit:v0.25.1', capAdd })
    return result.success ? [] : result.error.issues.map((issue) => issue.message)
  }

  it('takes Linux capabilities by name', () => {
    expect(messages(['SYS_ADMIN', 'NET_ADMIN'])).toEqual([])
    expect(messages([])).toEqual([])
  })

  it('refuses what is not a capability, ALL and a capability twice', () => {
    expect(messages(['ALL'])).toContain('unknown capability "ALL", expected a name such as SYS_ADMIN')
    expect(messages(['CAP_SYS_ADMIN'])).toContain(
      'unknown capability "CAP_SYS_ADMIN", expected a name such as SYS_ADMIN'
    )
    expect(messages(['SYS_ADMIN', 'SYS_ADMIN'])).toContain('a capability is listed twice')
  })

  it('is a property of container tasks only', () => {
    const local = buildFileSchema.safeParse({ tasks: { lint: { cmds: ['true'], capAdd: ['SYS_ADMIN'] } } })
    expect(local.success).toBe(false)
  })
})
