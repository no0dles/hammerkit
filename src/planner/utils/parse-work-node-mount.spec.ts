import { parseWorkNodeMount } from './parse-work-node-mount'
import { join } from 'path'
import { homedir } from 'os'

describe('parse-work-node-mount', () => {
  it('should parse "subdir"', () => {
    expect(parseWorkNodeMount('/home/test', 'subdir')).toEqual({
      localPath: '/home/test/subdir',
      containerPath: '/home/test/subdir',
    })
  })

  it('should parse "./subdir"', () => {
    expect(parseWorkNodeMount('/home/test', './subdir')).toEqual({
      localPath: '/home/test/subdir',
      containerPath: '/home/test/subdir',
    })
  })

  it('should parse "./subdir:./otherdir"', () => {
    expect(parseWorkNodeMount('/home/test', './subdir:./otherdir')).toEqual({
      localPath: '/home/test/subdir',
      containerPath: '/home/test/otherdir',
    })
  })

  it('should parse "$PWD/subdir:/subdir"', () => {
    expect(parseWorkNodeMount('/home/test', '$PWD/subdir:/subdir')).toEqual({
      localPath: join(homedir(), 'subdir'),
      containerPath: '/subdir',
    })
  })

  it('should parse "$PWD/subdir:$PWD/subdir"', () => {
    expect(parseWorkNodeMount('/home/test', '$PWD/subdir:$PWD/subdir')).toEqual({
      localPath: join(homedir(), 'subdir'),
      containerPath: '/home/test/subdir',
    })
  })

  it('should parse "/subdir:/otherdir"', () => {
    expect(parseWorkNodeMount('/home/test', '/subdir:/otherdir')).toEqual({
      localPath: '/subdir',
      containerPath: '/otherdir',
    })
  })

  it('should parse "/subdir:otherdir"', () => {
    expect(parseWorkNodeMount('/home/test', '/subdir:otherdir')).toEqual({
      localPath: '/subdir',
      containerPath: '/home/test/otherdir',
    })
  })

  it('should parse "subdir:/otherdir"', () => {
    expect(parseWorkNodeMount('/home/test', 'subdir:/otherdir')).toEqual({
      localPath: '/home/test/subdir',
      containerPath: '/otherdir',
    })
  })
})
