import { parseWorkVolume } from './parse-work-volume'

describe('parse-work-volume', () => {
  it('should parse projdata:/usr/data', () => {
    expect(parseWorkVolume('/home/user/proj', 'projdata:/usr/data', { replacements: [], variables: {} })).toEqual({
      name: 'projdata',
      containerPath: '/usr/data',
      resetOnChange: false,
      export: false,
      inherited: null,
      readOnly: false,
    })
  })

  it('should parse projdata:/usr/data:ro as read-only', () => {
    expect(
      parseWorkVolume('/home/user/proj', 'projdata:/usr/data:ro', { replacements: [], variables: {} })
    ).toMatchObject({ name: 'projdata', containerPath: '/usr/data', readOnly: true })
  })

  it('resolves env references in the volume name, as in mounts', () => {
    const envs = { replacements: [], variables: { DATA_PREFIX: 'ci-42' } }
    expect(parseWorkVolume('/home/user/proj', '${DATA_PREFIX}-db:/data/db', envs)).toMatchObject({
      name: 'ci-42-db',
      containerPath: '/data/db',
    })
    expect(parseWorkVolume('/home/user/proj', '$DATA_PREFIX-db:/data/db:ro', envs)).toMatchObject({
      name: 'ci-42-db',
      readOnly: true,
    })
  })

  it('throws for a volume string that is not name:path', () => {
    expect(() => parseWorkVolume('/home/user/proj', 'a:b:c', { replacements: [], variables: {} })).toThrow(
      'invalid volume a:b:c'
    )
  })
})
