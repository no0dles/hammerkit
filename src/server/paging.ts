/**
 * The pages of a list the API answers, and the values its filters can take.
 *
 * A list asked with `limit` answers that many at most, and `next` while more remain: the
 * `cursor` that asks for the page after it. A cursor is opaque to callers. Without `limit` a
 * list answers everything, as before lists were paged.
 *
 * A list asked with `values=<field>` answers the values that field has instead, each with how
 * many of the list have it, narrowed by `search` and paged the same way: what a filter offers
 * to choose from.
 */

// the most a page holds
export const MAX_LIMIT = 200
// the values of a field a page holds when the caller names no limit
export const VALUES_LIMIT = 50

export interface PageRequest {
  limit: number
  cursor?: string
}

export interface Page<T> {
  items: T[]
  next?: string
}

// A parameter of a list that is not right: the caller is answered 400 with the message.
export class ListParamError extends Error {}

// `limit` and `cursor`: undefined when the caller names no limit, and gets everything.
export function parsePage(params: URLSearchParams, fallback?: number): PageRequest | undefined {
  const limit = params.get('limit')
  const cursor = params.get('cursor') ?? undefined
  if (limit === null) {
    if (cursor !== undefined && fallback === undefined) {
      throw new ListParamError('cursor: only with limit')
    }
    return fallback === undefined ? undefined : { limit: fallback, ...(cursor !== undefined ? { cursor } : {}) }
  }
  if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > MAX_LIMIT) {
    throw new ListParamError(`limit: a number from 1 to ${MAX_LIMIT}`)
  }
  return { limit: Number(limit), ...(cursor !== undefined ? { cursor } : {}) }
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function decode(cursor: string): unknown {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString())
  } catch {
    throw new ListParamError('cursor: not one this server answered')
  }
}

// a key that orders a list newest first: a time (ISO), then an id for those of the same time
export type Key = [string, string]

const before = (a: Key, b: Key) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])

export function newestFirst<T>(items: T[], keyOf: (item: T) => Key): T[] {
  return [...items].sort((a, b) => {
    const x = keyOf(a)
    const y = keyOf(b)
    return before(x, y) ? 1 : before(y, x) ? -1 : 0
  })
}

/**
 * A page of a list ordered newest first, by the time `keyOf` gives (newestFirst, or the order
 * it was kept in): the cursor names the last one answered, by its time and id, so what is
 * added meanwhile does not repeat one. When the last one answered is gone, the page goes on
 * with the ones older than it.
 */
export function pageByKey<T>(items: T[], page: PageRequest, keyOf: (item: T) => Key): Page<T> {
  let start = 0
  if (page.cursor !== undefined) {
    const after = decode(page.cursor)
    if (!Array.isArray(after) || after.length !== 2 || !after.every((part) => typeof part === 'string')) {
      throw new ListParamError('cursor: not one this server answered')
    }
    const [at, id] = after as Key
    const last = items.findIndex((item) => keyOf(item)[1] === id)
    start = last >= 0 ? last + 1 : items.findIndex((item) => keyOf(item)[0] < at)
    if (start < 0) {
      return { items: [] }
    }
  }
  const answered = items.slice(start, start + page.limit)
  const more = start + page.limit < items.length
  return { items: answered, ...(more ? { next: encode(keyOf(answered[answered.length - 1])) } : {}) }
}

// A page of a list in an order of its own, such as numbers sorted by a column: by position.
export function pageByPosition<T>(items: T[], page: PageRequest): Page<T> {
  let start = 0
  if (page.cursor !== undefined) {
    const at = decode(page.cursor)
    if (typeof at !== 'object' || at === null || !Number.isSafeInteger((at as { at?: unknown }).at)) {
      throw new ListParamError('cursor: not one this server answered')
    }
    start = Math.max(0, (at as { at: number }).at)
  }
  const end = start + page.limit
  return { items: items.slice(start, end), ...(end < items.length ? { next: encode({ at: end }) } : {}) }
}

// The answer of a page: the list under its name, and `next` while more remain.
export function answerPage<T, K extends string>(name: K, page: Page<T>): { [key in K]: T[] } & { next?: string } {
  return { [name]: page.items, ...(page.next ? { next: page.next } : {}) } as { [key in K]: T[] } & {
    next?: string
  }
}

// One value of a field, with how many of the list have it, and how a person is named.
export interface ValueCount {
  value: string
  count: number
  name?: string
}

export interface ValuesRequest<F extends string> {
  field: F
  // the values that have this in them, in any case, in the value or its name
  search?: string
  page: PageRequest
}

// `values`, `search`, `limit` and `cursor`: undefined when the caller asks for the list.
export function parseValues<F extends string>(
  params: URLSearchParams,
  fields: readonly F[]
): ValuesRequest<F> | undefined {
  const field = params.get('values')
  if (field === null) {
    return undefined
  }
  if (!fields.includes(field as F)) {
    throw new ListParamError(`values: one of ${fields.join(', ')}`)
  }
  const search = params.get('search')?.trim().slice(0, 200)
  return {
    field: field as F,
    ...(search ? { search } : {}),
    page: parsePage(params, VALUES_LIMIT) as PageRequest,
  }
}

/**
 * The values `of` gives the items, each with how many items have it: the most first, then by
 * name, or in the order of `order`; narrowed by the search and paged by position.
 */
export function countValues<T>(
  items: T[],
  of: (item: T) => (string | { value: string; name?: string })[],
  request: Pick<ValuesRequest<string>, 'search' | 'page'>,
  order?: readonly string[]
): Page<ValueCount> {
  const counts = new Map<string, ValueCount>()
  for (const item of items) {
    const seen = new Set<string>()
    for (const found of of(item)) {
      const { value, name } = typeof found === 'string' ? { value: found, name: undefined } : found
      if (seen.has(value)) {
        continue
      }
      seen.add(value)
      const counted = counts.get(value) ?? { value, count: 0, ...(name ? { name } : {}) }
      counted.count++
      counts.set(value, counted)
    }
  }
  const needle = request.search?.toLowerCase()
  const values = [...counts.values()]
    .filter(
      (counted) =>
        !needle || counted.value.toLowerCase().includes(needle) || (counted.name ?? '').toLowerCase().includes(needle)
    )
    .sort((a, b) =>
      order ? order.indexOf(a.value) - order.indexOf(b.value) : b.count - a.count || a.value.localeCompare(b.value)
    )
  return pageByPosition(values, request.page)
}

// The values of a filter the caller names: the parameter repeated, `state=queued&state=running`.
export function readList(params: URLSearchParams, name: string): string[] | undefined {
  const values = params
    .getAll(name)
    .map((value) => value.trim())
    .filter(Boolean)
  return values.length > 0 ? values : undefined
}

// the text a list is searched for: `q`, at most 200 characters
export function readText(params: URLSearchParams): string | undefined {
  const text = params.get('q')?.trim().slice(0, 200)
  return text ? text : undefined
}

// Whether any of the values has the text in it, in any case.
export function hasText(values: (string | undefined)[], text: string): boolean {
  const needle = text.toLowerCase()
  return values.some((value) => !!value && value.toLowerCase().includes(needle))
}
