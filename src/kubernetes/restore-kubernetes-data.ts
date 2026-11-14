import { Environment } from '../executer/environment'
import { getArchivePaths } from '../executer/event-cache'
import { getErrorMessage } from '../log'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'
import { ContainerWorkTask } from '../planner/work-task'
import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { KubernetesInstance } from './kubernetes-instance'
import { getItemFilesDir, getKubernetesPersistence } from './volumes'
import { clearClaim, clearStateFiles, getPodForPersistence } from './ensure-persistent-data'
import { getClaimSubPath } from './claim-layout'

// Where the upload pod (which mounts the work's claim at /dev/hammerkit/<id>) unpacks the
// archive of an output: the output's place in the claim, which its mount reads
export function getRestoreTarget(
  work: WorkItem<ContainerWorkService | ContainerWorkTask>,
  path: string,
  // the folder of the state on a service run, see getStateFilesDir
  stateDir?: string
): string {
  return `/dev/hammerkit/${work.id()}/${stateDir ? `${stateDir}/` : ''}${getClaimSubPath(work, path)}`
}

export async function restoreKubernetesData(
  work: WorkItem<ContainerWorkService | ContainerWorkTask>,
  kubernetes: WorkKubernetesEnvironment,
  instance: KubernetesInstance,
  environment: Environment,
  path: string,
  // the kept claim of the work holds what an earlier run left, which goes first; on a
  // service run, the outputs go into the folder of `stateKey` (see getStateFilesDir);
  // `otherStates`: the folders of the other states go but these (the ones pods of the run
  // mount), and the folder of `stateKey` is emptied first
  options: { reset?: boolean; stateKey?: string; otherStates?: Set<string> } = {}
) {
  const persistence = await getKubernetesPersistence(work, kubernetes, options.stateKey)
  const stateDir = kubernetes.server?.serviceRun ? getItemFilesDir(work, options.stateKey) : undefined
  // a run stopped while the pod waits for room under the quota
  const { signal } = environment.abortCtrl
  await getPodForPersistence(instance, kubernetes, work, persistence, 'write', signal, async (name) => {
    if (options.reset) {
      await clearClaim(instance, kubernetes, work, name)
    }
    if (stateDir && options.otherStates) {
      await clearStateFiles(instance, kubernetes, work, name, stateDir, options.otherStates)
    }
    for (const generatedArchive of getArchivePaths(work.data, path)) {
      if (!(await environment.file.exists(generatedArchive.filename))) {
        continue
      }

      const targetPath = getRestoreTarget(work, generatedArchive.path, stateDir)
      // a claim made for this run (a server removes the claims of a run when it
      // ends) does not have the directory of the output yet
      let failure: string | null = null
      const res = await instance.exec.exec(
        kubernetes.namespace,
        name,
        'volume',
        ['sh', '-c', 'mkdir -p "$1" && tar xzf - -C "$1"', 'sh', targetPath],
        process.stdout,
        process.stderr,
        environment.file.readStream(generatedArchive.filename),
        false,
        (status) => {
          work.status.write('debug', `upload ${generatedArchive.filename} to ${name}: ${status.status}`)
          if (status.status !== 'Success') {
            failure = status.message ?? status.reason ?? 'unknown'
          }
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
            if (failure) {
              reject(new Error(`unable to restore ${generatedArchive.path} into ${name}: ${failure}`))
              return
            }
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
