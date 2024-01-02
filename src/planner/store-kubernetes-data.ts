import { WorkItem } from './work-item'
import { ContainerWorkService } from './work-service'
import { WorkKubernetesEnvironment } from './work-environment'
import { KubernetesInstance } from '../kubernetes/kubernetes-instance'
import { ContainerWorkTask } from './work-task'
import { Environment } from '../executer/environment'
import { getPodForPersistence } from '../kubernetes/ensure-persistent-data'
import { getKubernetesPersistence } from '../kubernetes/volumes'
import { getErrorMessage } from '../log'
import { getArchivePaths } from '../executer/event-cache'

export async function storeKubernetesData(
  work: WorkItem<ContainerWorkService | ContainerWorkTask>,
  kubernetes: WorkKubernetesEnvironment,
  instance: KubernetesInstance,
  environment: Environment,
  path: string
) {
  const persistence = await getKubernetesPersistence(work)
  await getPodForPersistence(instance, kubernetes, work, persistence, 'read', async (name) => {
    for (const generatedArchive of getArchivePaths(work.data, path)) {
      const writerStream = environment.file.createWriteStream(generatedArchive.filename)
      const res = await instance.exec.exec(
        kubernetes.namespace,
        name,
        'volume',
        ['tar', 'zcf', '-', '-C', generatedArchive.path, '.'],
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
