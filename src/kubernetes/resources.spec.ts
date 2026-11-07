import { getItemKey, getItemLabels, getItemSelector, getResourceName } from './resources'
import { getRunLabelValue } from './job-placement'

describe('names of the objects of an item', () => {
  const id = 'a'.repeat(40)
  const item = (name: string): any => ({ name, id: () => id })
  const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
  const onServer = (run: string): any => ({ server: { run } })

  it('keeps a plain name, so objects made before keep theirs', () => {
    expect(getResourceName(item('build'), {})).toBe(`build-${id}`)
    expect(getResourceName(item('build'), {}, '-secrets')).toBe(`build-${id}-secrets`)
  })

  it('makes a valid name of any task name, a job’s included', () => {
    for (const name of ['Build', 'build_app', 'lib:build', 'web.test', '-x', '__', 'a'.repeat(80), 'ü']) {
      for (const suffix of ['', '-job', '-credentials', '-download']) {
        for (const env of [{}, onServer('run_1')]) {
          const result = getResourceName(item(name), env, suffix)
          expect(result, `${name}${suffix}`).toMatch(DNS_LABEL)
          expect(result.length).toBeLessThanOrEqual(63)
          expect(result.endsWith(`${getItemKey(item(name), env)}${suffix}`)).toBe(true)
        }
      }
    }
    expect(getResourceName(item('lib:build'), {}, '-job')).toBe(`lib-build-${id}-job`)
  })

  it('gives the same task of two runs of a server objects of their own, found by both labels', () => {
    // two sandboxes of one repository run the same command in one namespace at the same time
    const first = getResourceName(item('shell'), onServer('run_1'), '-job')
    const second = getResourceName(item('shell'), onServer('run_2'), '-job')
    expect(first).not.toBe(second)
    expect(first).toBe(`shell-${id.substring(0, 32)}-${getRunLabelValue('run_1').substring(0, 8)}-job`)
    expect(getItemLabels(item('shell'), onServer('run_1'))).toEqual({
      'hammerkit.dev/id': id,
      'hammerkit.dev/run': getRunLabelValue('run_1'),
    })
    expect(getItemSelector(item('shell'), onServer('run_1'))).toBe(
      `hammerkit.dev/id=${id},hammerkit.dev/run=${getRunLabelValue('run_1')}`
    )
    // off a server the objects of an item outlive the run (a service of `up`), and keep the id alone
    expect(getItemSelector(item('shell'), {})).toBe(`hammerkit.dev/id=${id}`)
  })
})
