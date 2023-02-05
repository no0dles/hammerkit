import { parseWorkVolume } from './parse-work-volume'

describe('parse-work-volume', () => {
  it('should parse projdata:/usr/data', () => {
    expect(parseWorkVolume('/home/user/proj', 'projdata:/usr/data')).toEqual({
      name: 'projdata',
      containerPath: '/usr/data',
      resetOnChange: false,
      export: false,
      inherited: false,
    })
  })
})
