import { posix } from 'path'
import { Environment } from '../executer/environment'
import { getErrorMessage } from '../log'
import { getArchivePaths } from '../executer/event-cache'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'
import { ContainerWorkTask } from '../planner/work-task'
import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { KubernetesInstance } from './kubernetes-instance'
import { getKubernetesPersistence } from './volumes'
import { getPodForPersistence } from './ensure-persistent-data'

export async function storeKubernetesData(
  work: WorkItem<ContainerWorkService | ContainerWorkTask>,
  kubernetes: WorkKubernetesEnvironment,
  instance: KubernetesInstance,
  environment: Environment,
  path: string,
  // the state the outputs are of: on a service run, they are in its folder (see
  // getStateFilesDir)
  stateKey?: string
) {
  const persistence = await getKubernetesPersistence(work, kubernetes, stateKey)
  // a run stopped while the pod waits for room under the quota
  const { signal } = environment.abortCtrl
  // an output that is a file is mounted as one: its archive holds it by its name, as on Docker
  const files = new Set(
    work.data.type === 'container-task'
      ? work.data.generates
          .filter((generate) => generate.isFile && !generate.inherited)
          .map((generate) => generate.path)
      : []
  )
  await getPodForPersistence(instance, kubernetes, work, persistence, 'read', signal, async (name) => {
    for (const generatedArchive of getArchivePaths(work.data, path)) {
      const writerStream = environment.file.createWriteStream(generatedArchive.filename)
      const res = await instance.exec.exec(
        kubernetes.namespace,
        name,
        'volume',
        files.has(generatedArchive.path)
          ? ['tar', 'zcf', '-', '-C', posix.dirname(generatedArchive.path), posix.basename(generatedArchive.path)]
          : ['tar', 'zcf', '-', '-C', generatedArchive.path, '.'],
        writerStream,
        process.stderr,
        null,
        false,
        (status) => {
          work.status.write('debug', `archive ${generatedArchive.path} of ${name}: ${status}`)
          writerStream.close()
        }
      )

      await new Promise<void>((resolve, reject) => {
        try {
          res.on('open', () => {
            work.status.write('debug', `start download ${generatedArchive.path} of ${name}`)
          })
          res.on('error', (err) => {
            work.status.write(
              'error',
              `download during upload ${generatedArchive.path} of ${name}: ${getErrorMessage(err)}`
            )
            reject(err)
          })
          res.on('close', () => {
            work.status.write('debug', `downloaded ${generatedArchive.path} of ${name}`)
            resolve()
          })
        } catch (e) {
          reject(e)
        }
      })
    }
  })
}
