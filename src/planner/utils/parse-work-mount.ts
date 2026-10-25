import { homedir } from 'os'
import { getHomeReference, normalizeHostPath, normalizePath } from './normalize-path'
import { WorkMount } from '../work-mount'
import { extname } from 'path'

export function parseWorkMount(cwd: string, dir: string): WorkMount {
  const parts = dir.split(':')
  if (parts.length === 1) {
    const home = getHomeReference(dir)
    if (home === '~' || home === '$HOME') {
      // the container has no such directory: the same path on both sides would be one of the
      // project there (`$PWD` has always been, so it stays)
      throw new Error(`mount ${dir} is in the home directory, name where it goes in the container (${dir}:/path)`)
    }
    return parseLocalMount(cwd, dir, dir, dir, false)
  } else if (parts.length === 2) {
    return parseLocalMount(cwd, parts[0], parts[1], dir, false)
  } else if (parts.length === 3 && (parts[2] === 'ro' || parts[2] === 'rw')) {
    return parseLocalMount(cwd, parts[0], parts[1], dir, parts[2] === 'ro')
  } else {
    throw new Error(`invalid mount ${dir}`)
  }
}

function parseLocalMount(
  cwd: string,
  localPath: string,
  containerPath: string,
  mount: string,
  readOnly: boolean
): WorkMount {
  return {
    localPath: normalizeHostPath(cwd, homedir(), localPath),
    containerPath: normalizePath(cwd, cwd, containerPath),
    isFile: extname(localPath).length > 1,
    mount,
    readOnly,
  }
}
