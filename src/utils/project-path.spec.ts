import { isRelativePath } from './project-path'

describe('isRelativePath', () => {
  it.each(['app', 'app/screenshots', 'app/cypress/screenshots/tour.png', '.hidden', 'a..b', 'a.b/c-d_e'])(
    'takes %s',
    (path) => {
      expect(isRelativePath(path, 200)).toBe(true)
    }
  )

  it.each([
    ['empty', ''],
    ['absolute', '/etc/passwd'],
    ['a drive letter', 'C:/Windows'],
    ['a drive letter without a slash', 'C:Windows'],
    ['a backslash', 'app\\x'],
    ['a NUL', 'app/\0x'],
    ['an empty name', 'app//x'],
    ['a trailing slash', 'app/'],
    ['a dot name', 'app/./x'],
    ['a parent name', 'app/../x'],
  ])('refuses %s', (_, path) => {
    expect(isRelativePath(path, 200)).toBe(false)
  })

  it('refuses a path longer than the length given', () => {
    expect(isRelativePath('a'.repeat(200), 200)).toBe(true)
    expect(isRelativePath('a'.repeat(201), 200)).toBe(false)
  })
})
