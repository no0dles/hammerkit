import { useEffect, useRef, useState } from 'react'
import { printable } from './format'

export interface FilterOption {
  value: string
  // how many of what is listed have it
  count?: number
}

/**
 * A filter as a pill: its name, and what is chosen once something is. A click opens the
 * choices to tick, any number of them; none ticked lets everything through.
 */
export function FilterPill({
  name,
  options,
  chosen,
  onChange,
}: {
  name: string
  options: FilterOption[]
  chosen: string[]
  onChange: (chosen: string[]) => void
}) {
  const [open, setOpen] = useState(false)
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
  // what is chosen stays a choice when nothing listed has it any more
  const all: FilterOption[] = [
    ...options,
    ...chosen.filter((value) => !options.some((option) => option.value === value)).map((value) => ({ value })),
  ]
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
          <span className="truncate">{chosen.length === 1 ? printable(chosen[0]) : `${chosen.length} chosen`}</span>
        ) : null}
        <span aria-hidden="true" className="text-xs opacity-60">
          ▾
        </span>
      </button>
      {open ? (
        <div
          role="group"
          aria-label={name}
          className="absolute left-0 z-20 mt-1 flex max-h-80 w-64 max-w-[calc(100vw-2rem)] flex-col overflow-y-auto rounded-lg border border-stone-200 bg-white py-1 text-sm shadow-lg dark:border-stone-700 dark:bg-stone-900"
        >
          {all.length === 0 ? (
            <p className="px-3 py-1.5 text-stone-500 dark:text-stone-400">Nothing to choose in this period.</p>
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
                <span className="min-w-0 flex-1 truncate">{printable(option.value)}</span>
                {option.count !== undefined ? (
                  <span className="text-xs text-stone-500 tabular-nums dark:text-stone-400">{option.count}</span>
                ) : null}
              </label>
            ))
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
