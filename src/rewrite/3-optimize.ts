import {TreeDependencies, TreeDependencyNode} from './2-restructure';
import {join, dirname} from 'path';
import {existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from 'fs';
import {ContainerMount, TaskNode, TaskNodeCmd} from './1-plan';

export interface TreeNodeCache {
  src: string[]
  generates: string[]
  image: string | null;
  mounts: ContainerMount[]
  cmds: TaskNodeCmd[]
  envs: { [key: string]: string }
}

export interface TreeNodeCacheFile {
  task: TreeNodeCache
  stats: TreeNodeCacheStats
}

export interface TreeNodeCacheStats {
  [key: string]: { lastModified: number }
}

export function optimize(tree: TreeDependencies) {
  for (const key of Object.keys(tree)) {
    const node = tree[key];
    if (node.task.src.length === 0) {
      continue;
    }

    const cache = readCache(node);
    if (!cache) {
      continue;
    }

    const current = getCache(node);
    if (current.image !== cache.task.image) {
      continue;
    }

    // TODO compare other attrs

    const currentStats = getCacheStats(node.task);
    let changed = false;
    for (const key of Object.keys(cache.stats)) {
      if (currentStats[key]?.lastModified !== cache.stats[key].lastModified) {
        changed = true;
        break
      }
    }

    if (changed) {
      continue
    }

    removeTask(key, tree);
  }
}

function removeTask(keyToRemove: string, tree: TreeDependencies) {
  delete tree[keyToRemove];
  for (const key of Object.keys(tree)) {
    const index = tree[key].dependencies.indexOf(keyToRemove);
    if (index >= 0) {
      tree[key].dependencies.splice(index, 1);
    }
  }
}

function getCache(node: TreeDependencyNode): TreeNodeCache {
  return {
    src: node.task.src.map(s => s.absolutePath),
    generates: node.task.generates,
    cmds: node.task.cmds,
    image: node.task.image,
    mounts: node.task.mounts,
    envs: node.task.envs,
  };
}

function getCacheStats(cache: TaskNode): TreeNodeCacheStats {
  const result: TreeNodeCacheStats = {};

  for (const src of cache.src) {
    getStats(result, src.absolutePath, file => src.matcher(file, cache.path));
  }

  return result;
}

function getStats(result: TreeNodeCacheStats, path: string, matcher: (file: string) => boolean) {
  const stats = statSync(path);
  if (stats.isFile()) {
    if (matcher(path)) {
      result[path] = {lastModified: stats.mtimeMs};
    }
  } else if (stats.isDirectory()) {
    const files = readdirSync(path);
    for (const file of files) {
      const subPath = join(path, file)
      if (matcher(subPath)) {
        getStats(result, join(path, file), matcher);
      }
    }
  }
}

export function writeCache(node: TreeDependencyNode) {
  const cacheFile = join(node.task.path, '.hammerkit', node.task.name + '.json');
  const cache = getCache(node);
  const content: TreeNodeCacheFile = {
    task: cache,
    stats: getCacheStats(node.task),
  };
  mkdirSync(dirname(cacheFile), {recursive: true});
  writeFileSync(cacheFile, JSON.stringify(content, null, 2));
}

export function readCache(node: TreeDependencyNode): TreeNodeCacheFile | null {
  const cacheFile = join(node.task.path, '.hammerkit', node.task.name + '.json');
  if (!existsSync(cacheFile)) {
    return null;
  }

  return JSON.parse(readFileSync(cacheFile).toString());
}
