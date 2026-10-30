import { assertWithinRoot } from '../../file/within-root'
import { WorkItem } from '../work-item'
import { isContainerWorkService, WorkService } from '../work-service'
import { isContainerWorkTask, isWorkTask, WorkTask } from '../work-task'
import { WorkTree } from '../work-tree'
import { isVolumeName } from './hosted-volumes'

/**
 * Refuses an item whose sources, outputs or mounts leave the root of a run, or go
 * through a symbolic link in it. The server runs build files it did not write, in a
 * checkout it did not write either: a `src: ../..` or a link in the checkout would
 * have the server mount or upload its own files (its credentials, other callers'
 * caches) into a task. Checked when the run is planned and again before each item
 * runs, since an earlier task may have left a link behind.
 */
export async function assertItemPathsWithinRoot(item: WorkItem<WorkTask | WorkService>, root: string): Promise<void> {
  const data = item.data
  for (const source of 'src' in data ? data.src : []) {
    if (!source.inherited) {
      await assertWithinRoot(root, source.absolutePath, `${item.name}: src ${source.source}`)
    }
  }
  if (isContainerWorkTask(data) || isContainerWorkService(data)) {
    for (const mount of data.mounts) {
      await assertWithinRoot(root, mount.localPath, `${item.name}: mount ${mount.localPath}`)
    }
  }
  if (isContainerWorkService(data)) {
    for (const volume of data.volumes) {
      if (!isVolumeName(volume.name)) {
        throw new Error(
          `${item.name}: volume ${volume.name} is not a volume name, a path of the server can't be mounted`
        )
      }
    }
  }
  if (isWorkTask(data)) {
    for (const generate of data.generates) {
      if (!generate.inherited) {
        await assertWithinRoot(root, generate.path, `${item.name}: generates ${generate.path}`)
      }
    }
  }
}

export async function assertWorkTreePathsWithinRoot(workTree: WorkTree, root: string): Promise<void> {
  for (const item of [...Object.values(workTree.tasks), ...Object.values(workTree.services)]) {
    await assertItemPathsWithinRoot(item, root)
  }
}
