/**
 * A path relative to a root (of a project, a bundle, a sandbox), as the API and the CLI take
 * it: at most `maxLength` characters, `/` between names, no `.` or `..` or empty name, no
 * backslash, no NUL, nothing absolute (`/x`, `C:x`). The one rule every path an input names
 * is checked by, so the places that check it can not drift apart.
 */
export function isRelativePath(path: string, maxLength: number): boolean {
  return (
    path.length > 0 &&
    path.length <= maxLength &&
    !path.startsWith('/') &&
    !/^[A-Za-z]:/.test(path) &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !path.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
}
