import { Environment } from '../executer/environment'
import { getHealthcheckTimeout } from './utils/append-work-service'

function environmentWith(processEnvs: { [key: string]: string }): Environment {
  return { processEnvs } as unknown as Environment
}

describe('healthcheck timeout', () => {
  it('defaults to 20s', () => {
    expect(getHealthcheckTimeout(undefined, environmentWith({}))).toEqual(20_000)
  })

  it('uses HAMMERKIT_HEALTHCHECK_TIMEOUT as the default', () => {
    expect(getHealthcheckTimeout(undefined, environmentWith({ HAMMERKIT_HEALTHCHECK_TIMEOUT: '2m' }))).toEqual(120_000)
  })

  it('prefers the service healthcheck timeout', () => {
    expect(getHealthcheckTimeout('90s', environmentWith({ HAMMERKIT_HEALTHCHECK_TIMEOUT: '2m' }))).toEqual(90_000)
  })

  it('names the variable when its duration is invalid', () => {
    expect(() => getHealthcheckTimeout(undefined, environmentWith({ HAMMERKIT_HEALTHCHECK_TIMEOUT: 'soon' }))).toThrow(
      'HAMMERKIT_HEALTHCHECK_TIMEOUT: invalid duration "soon"'
    )
  })
})
