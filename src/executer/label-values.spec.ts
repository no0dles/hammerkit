import { appliesToLabels, hasLabels, matchesAnyLabel, mergeLabels } from './label-values'

describe('label-values', () => {
  describe('hasLabels', () => {
    it('is false for an empty object', () => {
      expect(hasLabels({})).toBe(false)
    })

    it('is true when at least one key is present', () => {
      expect(hasLabels({ app: ['web'] })).toBe(true)
    })
  })

  describe('matchesAnyLabel', () => {
    it('matches when a filter value is present in the labels', () => {
      expect(matchesAnyLabel({ app: ['web'] }, { app: ['web', 'api'] })).toBe(true)
    })

    it('does not match when the value is absent', () => {
      expect(matchesAnyLabel({ app: ['web'] }, { app: ['api'] })).toBe(false)
    })

    it('skips label keys that are missing or empty on the value', () => {
      expect(matchesAnyLabel({ app: ['web'] }, {})).toBe(false)
      expect(matchesAnyLabel({ app: ['web'] }, { app: [] })).toBe(false)
    })

    it('returns false for an empty filter', () => {
      expect(matchesAnyLabel({}, { app: ['web'] })).toBe(false)
    })
  })

  describe('appliesToLabels', () => {
    it('applies when there is no filter and no exclude', () => {
      expect(appliesToLabels({ app: ['web'] }, {})).toBe(true)
    })

    it('applies only when the filter matches', () => {
      expect(appliesToLabels({ app: ['web'] }, { filterLabels: { app: ['web'] } })).toBe(true)
      expect(appliesToLabels({ app: ['web'] }, { filterLabels: { app: ['api'] } })).toBe(false)
    })

    it('does not apply when an exclude matches', () => {
      expect(appliesToLabels({ app: ['web'] }, { excludeLabels: { app: ['web'] } })).toBe(false)
    })

    it('exclude wins over a matching filter', () => {
      expect(
        appliesToLabels(
          { app: ['web'], tier: ['frontend'] },
          { filterLabels: { app: ['web'] }, excludeLabels: { tier: ['frontend'] } }
        )
      ).toBe(false)
    })
  })

  describe('mergeLabels', () => {
    it('coerces scalar values into string arrays', () => {
      expect(mergeLabels({ app: 'web', port: 8080 })).toEqual({ app: ['web'], port: ['8080'] })
    })

    it('keeps array values as-is', () => {
      expect(mergeLabels({ app: ['web', 'api'] })).toEqual({ app: ['web', 'api'] })
    })

    it('merges multiple sources and dedupes values', () => {
      expect(mergeLabels({ app: 'web' }, { app: ['web', 'api'] }, { tier: 'frontend' })).toEqual({
        app: ['web', 'api'],
        tier: ['frontend'],
      })
    })

    it('ignores null and undefined sources', () => {
      expect(mergeLabels(null, undefined, { app: 'web' })).toEqual({ app: ['web'] })
    })
  })
})
