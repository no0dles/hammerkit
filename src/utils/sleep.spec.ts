import { sleep } from './sleep'

describe('utils/sleep', () => {
  it('should resolve not before timeout', () => {
    let called = false
    sleep(10).then(() => {
      called = true
    })
    expect(called).toBeFalsy()
  })
  it('should resolve after timeout', async () => {
    let called = false
    sleep(10).then(() => {
      called = true
    })
    expect(called).toBeFalsy()
    await sleep(10)
    expect(called).toBeTruthy()
  })
})
