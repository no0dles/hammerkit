import { join } from 'path'
import { writeFileSync } from 'fs'
import { stringify } from 'yaml'
import { CoreV1Api, KubeConfig } from '@kubernetes/client-node'
import { requiresKubernetes } from '../requires-kubernetes'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { expectSuccessfulResult } from '../expect'
import { getVolumeName } from '../../kubernetes/volumes'

// The claim of a task requests its volumeSize, else the environment's. A larger
// volumeSize grows the claim a run before made, where the storage class allows it;
// where it does not (kind's local-path), the task fails and says to clean.

const context = process.env.CLUSTER_NAME || 'docker-desktop'
const namespace = `hammerkit-k8s-vol-${(process.env.HAMMERKIT_TEST_RUN_ID ?? 'local').slice(0, 30)}`
  .toLowerCase()
  .replace(/[^a-z0-9-]+/g, '-')

function buildFile(bigSize: string) {
  return {
    environments: { default: { kubernetes: { context, namespace, volumeSize: '1536Mi' } } },
    tasks: {
      small: { image: 'alpine:3.21', src: ['input.txt'], generates: ['small'], cmds: ['mkdir -p small'] },
      big: {
        image: 'alpine:3.21',
        deps: ['small'],
        src: ['input.txt'],
        generates: ['big'],
        volumeSize: bigSize,
        cmds: ['mkdir -p big'],
      },
    },
  }
}

async function requestedStorage(name: string): Promise<string | undefined> {
  const config = new KubeConfig()
  config.loadFromDefault()
  config.setCurrentContext(context)
  const claim = await config.makeApiClient(CoreV1Api).readNamespacedPersistentVolumeClaim({ name, namespace })
  return claim.spec?.resources?.requests?.storage
}

describe('volume size (kubernetes)', () => {
  it(
    'gives each claim the size of its task, else of the environment, and grows it or says to clean',
    requiresKubernetes(async () => {
      await createTestCase('k8s-volume-size', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': buildFile('2Gi'),
        'input.txt': `${Date.now()}\n`,
      }).setup(async (cwd, environment) => {
        const file = join(cwd, '.hammerkit.yaml')
        const cli = await createCli(file, environment, { taskName: 'big', environmentName: 'default' })
        await expectSuccessfulResult(await cli.runExec(), environment)
        expect(await requestedStorage(getVolumeName(cli.task('big')))).toBe('2Gi')
        expect(await requestedStorage(getVolumeName(cli.task('small')))).toBe('1536Mi')

        // more for the next run, whose input changed
        writeFileSync(file, stringify(buildFile('3Gi')))
        writeFileSync(join(cwd, 'input.txt'), `${Date.now()}-again\n`)
        const again = await createCli(file, environment, { taskName: 'big', environmentName: 'default' })
        const result = await again.runExec()
        const big = getVolumeName(again.task('big'))
        if (result.success) {
          expect(await requestedStorage(big)).toBe('3Gi')
        } else {
          expect(result.state.tasks['big'].state.current).toMatchObject({
            type: 'error',
            errorMessage: expect.stringContaining(
              `the claim ${big} has 2Gi and big needs 3Gi, which its storage class could not grow it to`
            ),
          })
          expect(await requestedStorage(big)).toBe('2Gi')
        }
        await again.clean()
      })
    })
  )
})
