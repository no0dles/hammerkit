import { removeContainer } from './remove-container'
import { Container } from 'dockerode'

function makeContainer(remove: jest.Mock): Container {
  return { remove } as unknown as Container
}

describe('removeContainer', () => {
  it('removes the container on first try', async () => {
    const remove = jest.fn().mockResolvedValue(undefined)
    await removeContainer(makeContainer(remove))
    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith({ force: true })
  })

  it('swallows 404 (already gone)', async () => {
    const err = Object.assign(new Error('not found'), { statusCode: 404 })
    const remove = jest.fn().mockRejectedValueOnce(err)
    await expect(removeContainer(makeContainer(remove))).resolves.toBeUndefined()
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('retries on 409 (conflict)', async () => {
    const conflict = Object.assign(new Error('conflict'), { statusCode: 409 })
    const remove = jest
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce(undefined)
    await removeContainer(makeContainer(remove))
    expect(remove).toHaveBeenCalledTimes(2)
  }, 5000)

  it('rethrows unexpected errors', async () => {
    const err = Object.assign(new Error('boom'), { statusCode: 500 })
    const remove = jest.fn().mockRejectedValueOnce(err)
    await expect(removeContainer(makeContainer(remove))).rejects.toThrow('boom')
  })
})
