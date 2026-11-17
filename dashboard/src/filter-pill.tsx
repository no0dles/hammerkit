import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { printable } from './format'
import { inputClass } from './ui'
import { MorePages, rowsOf, useApiPages, useDebounced } from './paged'

export interface FilterOption {
  value: string
  // how many of what is listed have it
  count?: number
  // how the value is named, such as a person by their sign-in
  name?: string
}

// how many values of a filter a page of them holds
const VALUES_PAGE = 30

/**
 * A filter as a pill: its name, and what is chosen once something is. A click opens the
 * choices to tick, any number of them, with a search over them; none ticked lets everything
 * through. The choices are `options`, or what `values` answers (`GET ...?values=<field>`, see
 * src/server/paging.ts): those are searched on the server and load as they scroll.
 */
export function FilterPill({
  name,
  options,
  values,
  label,
  chosen,
  onChange,
}: {
  name: string
  options?: FilterOption[]
  // the path that answers the values of the filter, with what the page is narrowed by
  values?: string
  // how a value is named, when not as it is or as the server names it: also for a value chosen
  // that is not listed
  label?: (option: FilterOption) => string | undefined
  chosen: string[]
  onChange: (chosen: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) {
      return
    }
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !box.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])
  const nameOf = (option: FilterOption) => {
    const named = label?.(option) ?? option.name
    return printable(named ?? option.value)
  }
  const toggle = (value: string) =>
    onChange(chosen.includes(value) ? chosen.filter((other) => other !== value) : [...chosen, value])
  const active = chosen.length > 0
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="true"
        aria-expanded={open}
        className={`inline-flex max-w-72 items-center gap-1.5 rounded-full border px-3 py-0.5 text-sm ${
          active
            ? 'border-emerald-600 bg-emerald-50 text-emerald-800 dark:border-emerald-500 dark:bg-emerald-950 dark:text-emerald-200'
            : 'border-stone-300 text-stone-600 hover:border-stone-400 dark:border-stone-700 dark:text-stone-300 dark:hover:border-stone-500'
        }`}
      >
        <span className="font-medium">{name}</span>
        {active ? (
          <span className="truncate">
            {chosen.length === 1 ? nameOf({ value: chosen[0] }) : `${chosen.length} chosen`}
          </span>
        ) : null}
        <span aria-hidden="true" className="text-xs opacity-60">
          ▾
        </span>
      </button>
      {open ? (
        <div
          role="group"
          aria-label={name}
          className="absolute left-0 z-20 mt-1 flex w-64 max-w-[calc(100vw-2rem)] flex-col rounded-lg border border-stone-200 bg-white py-1 text-sm shadow-lg dark:border-stone-700 dark:bg-stone-900"
        >
          <div className="px-2 pt-1 pb-1.5">
            <input
              className={`${inputClass} w-full`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search"
              aria-label={`Search ${name}`}
              autoFocus
            />
          </div>
          {values !== undefined ? (
            <LoadedChoices path={values} search={search} chosen={chosen} nameOf={nameOf} toggle={toggle} />
          ) : (
            <Choices
              options={(options ?? []).filter((option) => matches(option, nameOf(option), search))}
              chosen={chosen}
              search={search}
              nameOf={nameOf}
              toggle={toggle}
            />
          )}
          {active ? (
            <button
              type="button"
              onClick={() => onChange([])}
              className="mx-3 mt-1 border-t border-stone-200 pt-1.5 pb-0.5 text-left text-xs text-emerald-700 hover:underline dark:border-stone-700 dark:text-emerald-400"
            >
              Clear
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function matches(option: FilterOption, named: string, search: string): boolean {
  const needle = search.trim().toLowerCase()
  return !needle || option.value.toLowerCase().includes(needle) || named.toLowerCase().includes(needle)
}

// The values of a filter as the server answers them, searched there, a page at a time.
function LoadedChoices({
  path,
  search,
  chosen,
  nameOf,
  toggle,
}: {
  path: string
  search: string
  chosen: string[]
  nameOf: (option: FilterOption) => string
  toggle: (value: string) => void
}) {
  const asked = useDebounced(search.trim())
  const list = useRef<HTMLDivElement>(null)
  const query = useApiPages<{ values: FilterOption[]; next?: string }>(
    `${path}${asked ? `&search=${encodeURIComponent(asked)}` : ''}`,
    { limit: VALUES_PAGE, refresh: false }
  )
  const options = rowsOf(
    query,
    (page) => page.values,
    (option) => option.value
  )
  if (query.isPending) {
    return <p className="px-3 py-1.5 text-stone-500 dark:text-stone-400">Loading…</p>
  }
  if (query.isError && !query.data) {
    return <p className="px-3 py-1.5 text-red-700 dark:text-red-400">{printable(query.error.message)}</p>
  }
  return (
    <Choices options={options} chosen={chosen} search={search} nameOf={nameOf} toggle={toggle} list={list}>
      <MorePages query={query} root={list} compact />
    </Choices>
  )
}

// The values to tick: those chosen that are not listed first, so they can be unticked.
function Choices({
  options,
  chosen,
  search,
  nameOf,
  toggle,
  list,
  children,
}: {
  options: FilterOption[]
  chosen: string[]
  search: string
  nameOf: (option: FilterOption) => string
  toggle: (value: string) => void
  list?: RefObject<HTMLDivElement | null>
  children?: ReactNode
}) {
  const all: FilterOption[] = [
    ...chosen
      .filter((value) => !options.some((option) => option.value === value))
      .map((value) => ({ value }))
      .filter((option) => matches(option, nameOf(option), search)),
    ...options,
  ]
  return (
    <div ref={list} className="flex max-h-72 flex-col overflow-y-auto">
      {all.length === 0 ? (
        <p className="px-3 py-1.5 text-stone-500 dark:text-stone-400">
          {search.trim() ? 'Nothing is like that.' : 'Nothing to choose.'}
        </p>
      ) : (
        all.map((option) => (
          <label
            key={option.value}
            className="flex cursor-pointer items-center gap-2 px-3 py-1 hover:bg-stone-100 dark:hover:bg-stone-800"
          >
            <input
              type="checkbox"
              className="accent-emerald-600"
              checked={chosen.includes(option.value)}
              onChange={() => toggle(option.value)}
            />
            <span className="min-w-0 flex-1 truncate" title={option.value}>
              {nameOf(option)}
            </span>
            {option.count !== undefined ? (
              <span className="text-xs text-stone-500 tabular-nums dark:text-stone-400">{option.count}</span>
            ) : null}
          </label>
        ))
      )}
      {children}
    </div>
  )
}

// The values a filter has in the address: `state=running,failed`.
export function readChosen(params: URLSearchParams, name: string): string[] {
  return (params.get(name) ?? '').split(',').filter(Boolean)
}

export function writeChosen(params: URLSearchParams, name: string, chosen: string[]): URLSearchParams {
  const next = new URLSearchParams(params)
  if (chosen.length > 0) {
    next.set(name, chosen.join(','))
  } else {
    next.delete(name)
  }
  return next
}

// How many of `items` have each value `of` gives them, most first, then by name.
export function countOptions<T>(items: T[], of: (item: T) => string[], order?: string[]): FilterOption[] {
  const counts = new Map<string, number>()
  for (const item of items) {
    for (const value of new Set(of(item))) {
      counts.set(value, (counts.get(value) ?? 0) + 1)
    }
  }
  return [...counts]
    .sort(([a, x], [b, y]) => (order ? order.indexOf(a) - order.indexOf(b) : y - x || a.localeCompare(b)))
    .map(([value, count]) => ({ value, count }))
}
