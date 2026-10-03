import { parseProcessStatusUser } from './main-process-user'

describe('parseProcessStatusUser', () => {
  it('reads the effective uid and gid of /proc/<pid>/status', () => {
    const status = ['Name:\tbeam.smp', 'Uid:\t100\t101\t100\t100', 'Gid:\t101\t102\t101\t101', 'Groups:\t101'].join(
      '\n'
    )
    expect(parseProcessStatusUser(status)).toEqual('101:102')
  })

  it('returns null without uid or gid lines', () => {
    expect(parseProcessStatusUser('Name:\tsh\n')).toBeNull()
  })
})
