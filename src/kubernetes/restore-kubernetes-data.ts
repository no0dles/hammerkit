import { Environment } from '../executer/environment'
import { getArchivePaths } from '../executer/event-cache'
import { getErrorMessage } from '../log'
import { basename } from 'path'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'
import { ContainerWorkTask } from '../planner/work-task'
import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { KubernetesInstance } from './kubernetes-instance'
import { getKubernetesPersistence } from './volumes'
import { getPodForPersistence } from './ensure-persistent-data'

export async function restoreKubernetesData(
  work: WorkItem<ContainerWorkService | ContainerWorkTask>,
  kubernetes: WorkKubernetesEnvironment,
  instance: KubernetesInstance,
  environment: Environment,
  path: string
) {
  const persistence = await getKubernetesPersistence(work)
  await getPodForPersistence(instance, kubernetes, work, persistence, 'write', async (name) => {
    for (const generatedArchive of getArchivePaths(work.data, path)) {
      if (!(await environment.file.exists(generatedArchive.filename))) {
        continue
      }

      const targetPath = `/dev/hammerkit/${work.id()}/${basename(generatedArchive.path)}`
      const res = await instance.exec.exec(
        kubernetes.namespace,
        name,
        'volume',
        ['tar', 'xzf', '-', '-C', targetPath],
        process.stdout,
        process.stderr,
        environment.file.readStream(generatedArchive.filename),
        false,
        (status) => {
          work.status.write('debug', `upload ${generatedArchive.filename} to ${name}: ${status}`)
        }
      )
      await new Promise<void>((resolve, reject) => {
        try {
          res.on('open', () => {
            work.status.write('debug', `start upload of ${generatedArchive.filename} to ${name}:${targetPath}`)
          })
          res.on('error', (err) => {
            work.status.write(
              'error',
              `error during upload of ${generatedArchive.filename} to ${name}: ${getErrorMessage(err)}`
            )
            reject(err)
          })
          res.on('close', () => {
            work.status.write('debug', `uploaded ${generatedArchive.filename} to ${name}:${targetPath}`)
            resolve()
          })
        } catch (e) {
          reject(e)
        }
      })
    }
  })
}
