import { join } from 'path'
import { parseBuildFile } from '../src/parse'

describe('invalid', () => {
  it('should throw on invalid yaml', () => {
    const fileName = join(__dirname, '../examples/invalid/build.yaml')
    expect(() => parseBuildFile(fileName, null)).toThrow(/unable to parse yaml.*/)
  })
})
