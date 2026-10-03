import { createDockerClient } from './execute-docker'

// GitLab's docker:dind service and remote daemons are reached through
// DOCKER_HOST=tcp://…; the client has to honour it when the build file
// configures no host of its own.
describe('createDockerClient', () => {
  const previous = process.env.DOCKER_HOST

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.DOCKER_HOST
    } else {
      process.env.DOCKER_HOST = previous
    }
  })

  it('connects to a tcp DOCKER_HOST', () => {
    process.env.DOCKER_HOST = 'tcp://docker:2375'
    const modem = (createDockerClient(undefined) as any).modem
    expect({ host: modem.host, port: modem.port }).toEqual({ host: 'docker', port: '2375' })
  })

  it('prefers the host from the build file', () => {
    process.env.DOCKER_HOST = 'tcp://docker:2375'
    expect((createDockerClient('builder.internal') as any).modem.host).toBe('builder.internal')
  })
})
