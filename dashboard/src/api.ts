import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { DashboardSession } from '../../src/server/dashboard'
import type { ListedRun, Meter, Overview, RunActions, QueuePlace } from '../../src/server/overview'
import type { Run } from '../../src/server/runs'
import type { Capacity } from '../../src/server/capacity'
import type { TaskStats } from '../../src/server/timings'
import type { LogPage } from '../../src/server/run-logs'
import type { Proposal } from '../../src/server/proposals'
import type { TaskPlan } from '../../src/server/plan'

/**
 * The app reads and does everything through the API of the server, as the person who signed
 * in: `/api/v1/...` of the dashboard host is `/v1/...` of the API (src/server/dashboard.ts).
 */

export type {
  DashboardSession,
  ListedRun,
  Meter,
  Overview,
  Capacity,
  TaskStats,
  LogPage,
  Proposal,
  TaskPlan,
  RunActions,
}

// GET /v1/runs/<id>: the run whole, for its owner, who decides about it and observe
export type FullRun = Omit<Run, 'owner'> & {
  owner?: { iss: string; sub: string }
  queue?: QueuePlace
  may?: RunActions
}

// GET /v1/approvals: a run that waits for the caller to decide
export interface ApprovalView {
  id: string
  state: Run['state']
  requestedBy: { iss: string; sub: string }
  createdAt: string
  definition: string
  tasks: string[]
  accounts: string[]
  plan?: Record<string, TaskPlan>
  source: Run['source']
  options?: Run['options']
  approvals?: Run['approvals']
}

export type ProposalView = Proposal & { mine: boolean; canDecide: boolean }

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    // the decision needs a newer sign-in
    readonly signInAgain = false
  ) {
    super(message)
  }
}

// Where a person signs in again and comes back to the page they are on.
export function signInPath(): string {
  const back = window.location.pathname + window.location.search
  return `/.hammerkit/signin?path=${encodeURIComponent(back)}`
}

let csrf = ''

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(method === 'POST' ? { 'content-type': 'application/json', 'x-hammerkit-csrf': csrf } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
  })
  if (response.status === 401) {
    // the sign-in ended: sign in again, and come back here
    window.location.assign(signInPath())
    throw new ApiError(401, 'signing in again')
  }
  const text = await response.text()
  let json: unknown
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    throw new ApiError(response.status, text.slice(0, 200) || response.statusText)
  }
  if (!response.ok) {
    const error = json as { error?: string; signInAgain?: boolean } | undefined
    throw new ApiError(response.status, error?.error ?? response.statusText, !!error?.signInAgain)
  }
  return json as T
}

export const get = <T>(path: string) => call<T>('GET', path)
export const post = <T>(path: string, body?: unknown) => call<T>('POST', path, body)

// pages that change are read again every 10 seconds, as `remote status --watch` would
export const REFRESH_MS = 10_000

export function useSession() {
  return useQuery({
    queryKey: ['session'],
    queryFn: async () => {
      const session = await get<DashboardSession>('/session')
      csrf = session.csrf
      return session
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
  })
}

export function useApi<T>(path: string, options: { refresh?: boolean; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['api', path],
    queryFn: () => get<T>(`/v1${path}`),
    refetchInterval: options.refresh === false ? false : REFRESH_MS,
    enabled: options.enabled ?? true,
    retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
  })
}

// What a button does: then every page reads again what it shows.
export function useAction<V = void>(action: (value: V) => Promise<unknown>) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: action,
    onSettled: () => client.invalidateQueries({ queryKey: ['api'] }),
  })
}

// A build file version in a path: `sha256:<hex>`, as the API takes it (not `%3A`)
export function hashPath(hash: string): string {
  return /^sha256:[0-9a-f]{64}$/.test(hash) ? hash : encodeURIComponent(hash)
}
