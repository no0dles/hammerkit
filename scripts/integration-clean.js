#!/usr/bin/env node
/*
 * Pre-integration cleanup (jest globalSetup for jest.integration.config.ts).
 *
 * Why this exists: local integration runs address resources by deterministic
 * names — namespaces are `hammerkit-{cache,env,k8s}-${HAMMERKIT_TEST_RUN_ID ??
 * 'local'}` and containers are labelled with a content-hash `hammerkit-id`. If a
 * run is interrupted (Ctrl-C, killed worker, crash) it leaves debris that wedges
 * the *next* run, because that run reuses the same names:
 *   - leftover (often paused) containers -> dockerTaskRuntime.initialize() finds
 *     a matching `hammerkit-id` and reports "Container already running".
 *   - a namespace whose pods reference an already-deleted PVC -> the new pods sit
 *     Pending forever and the k8s specs hang until the 900s test timeout.
 * Deleting the current run's namespaces and orphaned hammerkit containers up
 * front breaks that cycle.
 *
 * Scope: only the namespaces THIS run will use (derived from the run id) and
 * containers labelled app=hammerkit. CI uses a unique HAMMERKIT_TEST_RUN_ID, so
 * those namespaces never pre-exist there and a concurrent run is never touched.
 *
 * Best effort: if docker or the kube context is unavailable the step logs and
 * continues, so a docker-only environment still runs.
 */
const Dockerode = require('dockerode')
const { KubeConfig, CoreV1Api } = require('@kubernetes/client-node')

const runId = process.env.HAMMERKIT_TEST_RUN_ID || 'local'
const context = process.env.CLUSTER_NAME || 'docker-desktop'

// must match the namespace names the integration specs build
const namespaceTargets = [
  `hammerkit-cache-${runId.slice(0, 30)}`,
  `hammerkit-env-${runId.slice(0, 40)}`,
  `hammerkit-k8s-${runId.slice(0, 40)}`,
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function cleanupContainers() {
  let docker
  try {
    docker = new Dockerode()
    await docker.ping()
  } catch (e) {
    console.warn(`[integration clean] docker unavailable, skipping container cleanup: ${e.message}`)
    return
  }

  let containers
  try {
    containers = await docker.listContainers({ all: true, filters: { label: ['app=hammerkit'] } })
  } catch (e) {
    console.warn(`[integration clean] could not list containers: ${e.message}`)
    return
  }

  let removed = 0
  for (const info of containers) {
    const container = docker.getContainer(info.Id)
    try {
      if (info.State === 'paused') {
        await container.unpause().catch(() => undefined)
      }
      await container.remove({ force: true })
      removed++
    } catch {
      // best effort: a racing removal or already-gone container is fine
    }
  }
  if (removed > 0) {
    console.log(`[integration clean] removed ${removed} leftover hammerkit container(s)`)
  }
}

async function cleanupNamespaces() {
  let coreApi
  try {
    const kc = new KubeConfig()
    kc.loadFromDefault()
    kc.setCurrentContext(context)
    coreApi = kc.makeApiClient(CoreV1Api)
  } catch (e) {
    console.warn(`[integration clean] kube context "${context}" unavailable, skipping namespace cleanup: ${e.message}`)
    return
  }

  const exists = async (name) => {
    try {
      await coreApi.readNamespace(name)
      return true
    } catch {
      return false
    }
  }

  const existing = []
  for (const name of namespaceTargets) {
    if (await exists(name)) {
      existing.push(name)
    }
  }
  if (existing.length === 0) {
    return
  }

  console.log(`[integration clean] deleting leftover namespace(s): ${existing.join(', ')}`)
  for (const name of existing) {
    try {
      await coreApi.deleteNamespace(name)
    } catch {
      // already terminating or gone
    }
  }

  // wait until they are fully gone, otherwise the suite's createNamespace races
  // a Terminating namespace and fails.
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    let remaining = 0
    for (const name of existing) {
      if (await exists(name)) {
        remaining++
      }
    }
    if (remaining === 0) {
      console.log('[integration clean] leftover namespaces terminated')
      return
    }
    await sleep(2000)
  }
  console.warn('[integration clean] timed out waiting for namespaces to terminate; continuing anyway')
}

module.exports = async function globalSetup() {
  await cleanupContainers()
  await cleanupNamespaces()
}
