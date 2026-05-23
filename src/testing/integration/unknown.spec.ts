import 'jest-extended'
import { createTestCase } from '../test-case'
import { ParseError } from '../../schema/parse-error'

describe('unknown', () => {
  it('should validate unknown props', async () => {
    const testCase = createTestCase('wrong-cmd', {
      '.hammerkit.yaml': {
        example: {
          cmd: ['echo wrong cmd'],
        },
      },
    })
    await expect(testCase.cli({ taskName: 'example' })).rejects.toThrow(ParseError)
  })

  it('should validate unknown container props for local tasks', async () => {
    const testCase = createTestCase('wrong-cmd', {
      '.hammerkit.yaml': {
        example: {
          cmds: ['echo hello'],
          mounts: ['/.npm:/.npm'],
        },
      },
    })
    await expect(testCase.cli({ taskName: 'example' })).rejects.toThrow(ParseError)
  })
})
