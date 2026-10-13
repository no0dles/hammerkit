import { getResourceName } from './resources'

describe('names of the objects of an item', () => {
  const id = 'a'.repeat(40)
  const item = (name: string): any => ({ name, id: () => id })
  const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

  it('keeps a plain name, so objects made before keep theirs', () => {
    expect(getResourceName(item('build'))).toBe(`build-${id}`)
    expect(getResourceName(item('build'), '-secrets')).toBe(`build-${id}-secrets`)
  })

  it('makes a valid name of any task name, a job’s included', () => {
    for (const name of ['Build', 'build_app', 'lib:build', 'web.test', '-x', '__', 'a'.repeat(80), 'ü']) {
      for (const suffix of ['', '-job', '-credentials', '-download']) {
        const result = getResourceName(item(name), suffix)
        expect(result, `${name}${suffix}`).toMatch(DNS_LABEL)
        expect(result.length).toBeLessThanOrEqual(63)
        expect(result.endsWith(`${id}${suffix}`)).toBe(true)
      }
    }
    expect(getResourceName(item('lib:build'), '-job')).toBe(`lib-build-${id}-job`)
  })
})
