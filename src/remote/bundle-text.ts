import { Bundle } from './bundle'

// Text from a proposal is shown to somebody who decides on it, so nothing in it may
// rewrite the terminal or hide what it says: control and format characters (which
// include the ones that reorder text) are shown as `?`. Long lines are not cut,
// what is hidden behind a cut is what a reviewer needs to see.
export function visible(line: string): string {
  return line.replace(/\t/g, '  ').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '?')
}

const lines = (text: string) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'))

// Every file of a version, whole: a version has no other one it could be read
// against, whoever decides on it reads all of it.
export function showBundle(bundle: Bundle): string[] {
  return Object.keys(bundle.files)
    .sort()
    .flatMap((path) => [
      `--- ${visible(path)}${path === bundle.entry ? ' (entry)' : ''}`,
      ...lines(bundle.files[path]).map((line) => `  ${visible(line)}`),
    ])
}
