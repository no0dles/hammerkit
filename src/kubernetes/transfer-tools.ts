import { posix } from 'path'
import { V1Container, V1EnvVar, V1Volume, V1VolumeMount } from '@kubernetes/client-node'

// Pinned, static (it runs in any image) busybox: the tools of the pods hammerkit runs its own
// commands in, such as the runner of a sandbox and the pods that copy files into and out of
// a claim. To bump it, take the index digest of the tag (`docker buildx imagetools inspect
// busybox:<version>-musl`).
export const HELPER_TOOLS_IMAGE =
  'busybox:1.37.0-musl@sha256:5cec3fc171c87218698e85a52af7087de727372aae264a787b8112901a5b0092'

/**
 * The pod that copies files into and out of a claim mounts the outputs of a task at the
 * paths the task wrote them to, which may be any path, /bin included. So what it runs comes
 * from a folder no mount of the task can be: an init container copies the pinned busybox
 * into it and links each of its tools there, and the pod's own container finds them by its
 * PATH, mounted read-only. Every command starts with the busybox itself, so a tool of the
 * same name in a mounted output never runs.
 */
export const TRANSFER_TOOLS_PATH = '/.hammerkit'
const TRANSFER_TOOLS_VOLUME = 'hammerkit-transfer-tools'
export const TRANSFER_BUSYBOX = `${TRANSFER_TOOLS_PATH}/busybox`
const TRANSFER_BIN = `${TRANSFER_TOOLS_PATH}/bin`

// a path in or over the folder of the tools (`/`, `/.hammerkit`, `/.hammerkit/bin`), where a
// mount would hide them
export function isTransferToolsPath(path: string): boolean {
  const normalized = posix.normalize(path).replace(/\/+$/, '') || '/'
  return normalized === '/' || normalized === TRANSFER_TOOLS_PATH || normalized.startsWith(`${TRANSFER_TOOLS_PATH}/`)
}

// `command` (a tool and its arguments) run by the busybox of the transfer pod
export function inTransferPod(command: string[]): string[] {
  return [TRANSFER_BUSYBOX, ...command]
}

export function getTransferToolsInitContainer(): V1Container {
  return {
    name: TRANSFER_TOOLS_VOLUME,
    image: HELPER_TOOLS_IMAGE,
    command: [
      '/bin/busybox',
      'sh',
      '-c',
      `/bin/busybox cp /bin/busybox ${TRANSFER_BUSYBOX} && /bin/busybox mkdir -p ${TRANSFER_BIN} && ${TRANSFER_BUSYBOX} --install -s ${TRANSFER_BIN}`,
    ],
    volumeMounts: [{ name: TRANSFER_TOOLS_VOLUME, mountPath: TRANSFER_TOOLS_PATH }],
    securityContext: {
      runAsNonRoot: true,
      runAsUser: 65534,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] },
    },
    // its own requests: the defaults of a namespace are sized for tasks, and a pod's
    // request is the larger of its init containers' and the sum of its containers'
    resources: { requests: { cpu: '10m', memory: '16Mi' }, limits: { memory: '16Mi' } },
  }
}

export const TRANSFER_TOOLS_VOLUMES: V1Volume[] = [{ name: TRANSFER_TOOLS_VOLUME, emptyDir: {} }]

export const TRANSFER_TOOLS_MOUNT: V1VolumeMount = {
  name: TRANSFER_TOOLS_VOLUME,
  mountPath: TRANSFER_TOOLS_PATH,
  readOnly: true,
}

// the tools a script of the transfer pod runs, and nothing else
export const TRANSFER_TOOLS_ENV: V1EnvVar[] = [{ name: 'PATH', value: TRANSFER_BIN }]
