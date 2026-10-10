import { formatDuration, parseCpus, parseDuration, parseSize } from './units'

describe('parseDuration', () => {
  it.each([
    ['500ms', 500],
    ['30s', 30_000],
    ['5m', 300_000],
    ['2h', 7_200_000],
    ['30d', 2_592_000_000],
    ['1h30m', 5_400_000],
    ['1.5h', 5_400_000],
  ])('parses %s', (value, expected) => {
    expect(parseDuration(value)).toBe(expected)
  })

  it.each(['', '10', 'm', '5x', '-5m', '5 m', '0s'])('rejects %j', (value) => {
    expect(() => parseDuration(value)).toThrow(/duration/)
  })
})

describe('formatDuration', () => {
  it.each([
    [500, '500ms'],
    [30_000, '30s'],
    [300_000, '5m'],
    [5_400_000, '1h30m'],
    [2_592_000_000, '30d'],
  ])('formats %d as %s', (value, expected) => {
    expect(formatDuration(value)).toBe(expected)
  })
})

describe('parseSize', () => {
  it.each([
    ['512', 512],
    ['1Ki', 1024],
    ['500Mi', 500 * 1024 ** 2],
    ['5Gi', 5 * 1024 ** 3],
    ['1Ti', 1024 ** 4],
    ['1K', 1000],
    ['2G', 2_000_000_000],
    ['1.5Gi', 1.5 * 1024 ** 3],
  ])('parses %s', (value, expected) => {
    expect(parseSize(value)).toBe(expected)
  })

  it.each(['', 'Gi', '5 Gi', '-1Gi', '5GB', '5gi'])('rejects %j', (value) => {
    expect(() => parseSize(value)).toThrow(/size/)
  })
})

describe('parseCpus', () => {
  it.each<[string | number, number]>([
    [2, 2],
    [0.5, 0.5],
    ['2', 2],
    ['1.5', 1.5],
    ['500m', 0.5],
    ['1m', 0.001],
    ['2500m', 2.5],
  ])('parses %j', (value, expected) => {
    expect(parseCpus(value)).toBe(expected)
  })

  it.each<string | number>(['', '0', 0, '0m', '-1', -1, '0.0001', '1.5m', '2 cores', 'm', '1Gi'])(
    'rejects %j',
    (value) => {
      expect(() => parseCpus(value)).toThrow(/cpus/)
    }
  )
})
