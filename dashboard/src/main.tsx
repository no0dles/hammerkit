import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, Navigate, NavLink, Outlet, useParams } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import { useApi, useSession, type ApprovalView, type ProposalView } from './api'
import { ErrorNote, T } from './ui'
import { OverviewPage } from './pages/overview'
import { ServicesPage } from './pages/services'
import { RunsPage } from './pages/runs'
import { RunPage } from './pages/run'
import { LogPage } from './pages/log'
import { TasksPage } from './pages/tasks'
import { VersionPage } from './pages/version'
import { BuildFilePage, BuildFilesPage, proposedPath } from './pages/build-file'
import { SandboxesPage, SandboxPage } from './pages/sandboxes'

const NAV: [string, string][] = [
  ['/', 'Overview'],
  ['/services', 'Services'],
  ['/runs', 'Runs'],
  ['/tasks', 'Tasks'],
  ['/build-files', 'Build files'],
  ['/sandboxes', 'Sandboxes'],
]

// what waits for the person to decide, by the page it is decided on: runs and versions
function useWaitingForMe(): Record<string, number> {
  const runs = useApi<{ approvals: ApprovalView[] }>('/approvals')
  const versions = useApi<{ proposals: ProposalView[] }>('/proposals')
  return {
    '/runs': runs.data?.approvals.length ?? 0,
    '/build-files': versions.data?.proposals.filter((p) => p.canDecide).length ?? 0,
  }
}

// the page of a proposed version had its address under the approvals
function OldVersionPath() {
  return <Navigate to={proposedPath(useParams().hash ?? '')} replace />
}

function Layout() {
  const session = useSession()
  const waiting = useWaitingForMe()
  return (
    <div className="min-h-screen">
      <header className="border-b border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <strong className="flex items-center gap-2 font-semibold">
            <img src="/logo.png" alt="" className="h-6 w-6" />
            hammerkit
          </strong>
          <nav className="order-last flex w-full flex-wrap gap-x-4 gap-y-1 text-sm md:order-none md:w-auto md:flex-1">
            {NAV.map(([to, name]) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
                className={({ isActive }) =>
                  `border-b-2 py-1 ${
                    isActive
                      ? 'border-emerald-600 font-medium text-stone-900 dark:text-white'
                      : 'border-transparent text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-white'
                  }`
                }
              >
                {name}
                {waiting[to] ? (
                  <span
                    className="ml-1 rounded-full bg-amber-500 px-1.5 text-xs font-medium text-white"
                    title="waiting for you to decide"
                  >
                    {waiting[to]}
                  </span>
                ) : null}
              </NavLink>
            ))}
          </nav>
          <span className="ml-auto text-sm text-stone-500 dark:text-stone-400">
            {session.data ? (
              <>
                <T>{session.data.sub}</T>
                {session.data.observe ? ' · observes' : ''} ·{' '}
              </>
            ) : null}
            <a className="link" href="/.hammerkit/logout">
              Sign out
            </a>
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        {session.isError ? <ErrorNote error={session.error} /> : session.data ? <Outlet /> : null}
      </main>
    </div>
  )
}

function NotFound() {
  return <p className="text-sm text-stone-500">There is no such page.</p>
}

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <OverviewPage /> },
      { path: '/services', element: <ServicesPage /> },
      { path: '/runs', element: <RunsPage /> },
      { path: '/runs/:id', element: <RunPage /> },
      { path: '/runs/:id/log', element: <LogPage /> },
      { path: '/tasks', element: <TasksPage /> },
      { path: '/sandboxes', element: <SandboxesPage /> },
      { path: '/sandboxes/:id', element: <SandboxPage /> },
      { path: '/build-files', element: <BuildFilesPage /> },
      { path: '/build-files/proposed/:hash', element: <VersionPage /> },
      { path: '/build-files/:hash', element: <BuildFilePage /> },
      // runs are approved on the runs, versions published on the build files
      { path: '/approvals', element: <Navigate to="/runs" replace /> },
      { path: '/approvals/versions/:hash', element: <OldVersionPath /> },
      // the capacity is a part of the overview
      { path: '/capacity', element: <Navigate to="/" replace /> },
      { path: '*', element: <NotFound /> },
    ],
  },
])

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: true, staleTime: 2000 } },
})

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>
)
