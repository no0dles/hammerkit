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

  it('reads a third :ro part as read-only, :rw and two parts as writable', () => {
    expect(parseWorkMount('/home/test', './config.json:/etc/app.json:ro')).toMatchObject({
      localPath: normalizePath('/home/test/config.json'),
      containerPath: '/etc/app.json',
      readOnly: true,
    })
    expect(parseWorkMount('/home/test', './data:/data:rw')).toMatchObject({ readOnly: false })
    expect(parseWorkMount('/home/test', './data:/data')).toMatchObject({ readOnly: false })
  })

  it('throws for a third part that is not ro or rw', () => {
    expect(() => parseWorkMount('/home/test', 'a:b:c')).toThrow('invalid mount a:b:c')
  })
})
