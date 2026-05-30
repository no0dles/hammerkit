import { homedir } from 'os'
import { join } from 'path'
import { getDefaultKubeConfig } from './get-default-kube-config'

describe('getDefaultKubeConfig', () => {
  it('returns ~/.kube/config', () => {
    expect(getDefaultKubeConfig()).toBe(join(homedir(), '.kube/config'))
  })
})
