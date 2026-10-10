import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { ContainerWorkService } from '../planner/work-service'
import { WorkItem } from '../planner/work-item'
import { getServiceInstructions } from './package'

const options = { registry: 'registry.example.com', username: null, password: null, push: false, overrideUser: false }

async function instructionsOf(name: string, service: object): Promise<string[]> {
  let instructions: string[] = []
  await createTestCase(name, {
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.hammerkit.yaml': { services: { api: service } },
  }).setup(async (cwd, environment) => {
    const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {})
    const item = cli.ls().find((i) => i.type === 'service')?.item as WorkItem<ContainerWorkService>
    instructions = getServiceInstructions(item, options).instructions.filter((i) => i.length > 0)
  })
  return instructions
}

describe('package service workdir', () => {
  it('ends with the declared workdir, after the copies', async () => {
    const instructions = await instructionsOf('package-workdir-declared', {
      image: 'example/core:6',
      workdir: '/app/core',
      cmd: 'node dist/index.js',
    })
    const workdirs = instructions.filter((i) => i.startsWith('WORKDIR '))
    expect(workdirs[workdirs.length - 1]).toEqual('WORKDIR /app/core')
    expect(instructions.indexOf('WORKDIR /app/core')).toBeLessThan(instructions.findIndex((i) => i.startsWith('CMD ')))
  })

  it('keeps only the build directory without workdir', async () => {
    const instructions = await instructionsOf('package-workdir-default', { image: 'postgres:16' })
    expect(instructions.filter((i) => i.startsWith('WORKDIR '))).toHaveLength(1)
  })
})
