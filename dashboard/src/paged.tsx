import { useEffect, useRef, useState, type RefObject } from 'react'
import {
  keepPreviousData,
  useInfiniteQuery,
  type InfiniteData,
  type UseInfiniteQueryResult,
} from '@tanstack/react-query'
import { ApiError, get, REFRESH_MS } from './api'
import { ErrorNote } from './ui'

/**
 * A list the API pages (src/server/paging.ts): `limit` and `cursor` ask for a page, `next`
 * names the one after it. The pages loaded are read again together every REFRESH_MS.
 */

// how many rows a page of a list holds
export const PAGE_SIZE = 50

export type Paged = { next?: string }
export type PagedQuery<P extends Paged> = UseInfiniteQueryResult<InfiniteData<P>>

// `path` with the parameters of a page added
function pagePath(path: string, limit: number, cursor: string | undefined): string {
  const [base, query = ''] = path.split('?', 2)
  const params = new URLSearchParams(query)
  params.set('limit', String(limit))
  if (cursor) {
    params.set('cursor', cursor)
  }
  return `${base}?${params}`
}

export function useApiPages<P extends Paged>(
  path: string,
  options: { limit?: number; refresh?: boolean; enabled?: boolean } = {}
): PagedQuery<P> {
  const { limit = PAGE_SIZE, refresh = true, enabled = true } = options
  return useInfiniteQuery({
    queryKey: ['api', path, 'pages', limit],
    queryFn: ({ pageParam }) => get<P>(`/v1${pagePath(path, limit, pageParam)}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next,
    // what was listed stays while a list narrowed by a filter or a search loads
    placeholderData: keepPreviousData,
    refetchInterval: refresh ? REFRESH_MS : false,
    enabled,
    retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
  })
}

// The rows of every page loaded, each once: a row that moved to a later page while the pages
// were read again shows where it was first.
export function rowsOf<P extends Paged, T>(query: PagedQuery<P>, of: (page: P) => T[], keyOf: (row: T) => string): T[] {
  const rows = new Map<string, T>()
  for (const page of query.data?.pages ?? []) {
    for (const row of of(page)) {
      if (!rows.has(keyOf(row))) {
        rows.set(keyOf(row), row)
      }
    }
  }
  return [...rows.values()]
}

/**
 * Below a list: loads the next page once it scrolls into view (within `root`, the box that
 * scrolls, the page when left out), and a button that does the same where nothing scrolls.
 */
export function MorePages<P extends Paged>({
  query,
  root,
  compact,
}: {
  query: PagedQuery<P>
  root?: RefObject<HTMLElement | null>
  compact?: boolean
}) {
  const sentinel = useRef<HTMLDivElement>(null)
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = query
  useEffect(() => {
    const element = sentinel.current
    // a page that failed waits for the button, so it is not asked for again and again
    if (!element || !hasNextPage || isFetchNextPageError || typeof IntersectionObserver === 'undefined') {
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage) {
          void fetchNextPage()
        }
      },
      { root: root?.current ?? null, rootMargin: '200px' }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage, root])
  if (!hasNextPage) {
    return null
  }
  return (
    <div ref={sentinel} className={`flex flex-col items-center gap-1 ${compact ? 'py-1' : 'mt-3'}`}>
      {isFetchNextPageError ? <ErrorNote error={query.error} /> : null}
      <button
        type="button"
        onClick={() => void fetchNextPage()}
        disabled={isFetchingNextPage}
        className={`text-emerald-700 hover:underline disabled:text-stone-500 disabled:no-underline dark:text-emerald-400 ${
          compact ? 'text-xs' : 'text-sm'
        }`}
      >
        {isFetchingNextPage ? 'Loading…' : 'Load more'}
      </button>
    </div>
  )
}

// A value that follows `value` once it stopped changing for `ms`: what is typed, asked for once.
export function useDebounced<T>(value: T, ms = 250): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

// The filters a page has in its address, as the API takes them: each value of `state=a,b` as
// `state=a&state=b`.
export function appendChosen(query: URLSearchParams, chosen: Record<string, string[]>): URLSearchParams {
  const next = new URLSearchParams(query)
  for (const [key, values] of Object.entries(chosen)) {
    for (const value of values) {
      next.append(key, value)
    }
  }
  return next
}
