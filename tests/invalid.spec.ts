import {loadExampleBuildFile} from './run-arg';

describe('invalid', () => {
  it('should throw on invalid yaml', () => {
    expect(() => loadExampleBuildFile('invalid')).toThrow(/unable to parse.*/)
  })
})
