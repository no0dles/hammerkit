import { parseWorkMount } from './parse-work-mount'
import { join, sep, posix } from 'path'
import { homedir } from 'os'

function normalizePath(val: string): string {
  return val.split(posix.sep).join(sep)
}

describe('parse-work-mount', () => {
  it('should parse "subdir"', () => {
    expect(parseWorkMount('/home/test', 'subdir')).toMatchObject({
      localPath: normalizePath('/home/test/subdir'),
      containerPath: normalizePath('/home/test/subdir'),
    })
  })

  it('should parse "./subdir"', () => {
    expect(parseWorkMount('/home/test', './subdir')).toMatchObject({
      localPath: normalizePath('/home/test/subdir'),
      containerPath: normalizePath('/home/test/subdir'),
    })
  })

  it('should parse "./subdir:./otherdir"', () => {
    expect(parseWorkMount('/home/test', './subdir:./otherdir')).toMatchObject({
      localPath: normalizePath('/home/test/subdir'),
      containerPath: normalizePath('/home/test/otherdir'),
    })
  })

  it('should parse "$PWD/subdir:/subdir"', () => {
    expect(parseWorkMount('/home/test', '$PWD/subdir:/subdir')).toMatchObject({
      localPath: join(homedir(), 'subdir'),
      containerPath: '/subdir',
    })
  })

  it('should parse "$PWD/subdir:$PWD/subdir"', () => {
    expect(parseWorkMount('/home/test', '$PWD/subdir:$PWD/subdir')).toMatchObject({
      localPath: join(homedir(), 'subdir'),
      containerPath: normalizePath('/home/test/subdir'),
    })
  })

  it('should parse "/subdir:/otherdir"', () => {
    expect(parseWorkMount('/home/test', '/subdir:/otherdir')).toMatchObject({
      localPath: '/subdir',
      containerPath: '/otherdir',
    })
  })

  it('should parse "/subdir:otherdir"', () => {
    expect(parseWorkMount('/home/test', '/subdir:otherdir')).toMatchObject({
      localPath: '/subdir',
      containerPath: normalizePath('/home/test/otherdir'),
    })
  })

  it('should parse "subdir:/otherdir"', () => {
    expect(parseWorkMount('/home/test', 'subdir:/otherdir')).toMatchObject({
      localPath: normalizePath('/home/test/subdir'),
      containerPath: '/otherdir',
    })
  })
})
