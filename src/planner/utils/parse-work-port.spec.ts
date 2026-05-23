import { parseWorkPort } from './parse-work-port'

describe('parse-work-port', () => {
  it('should parse 5432', () => {
    expect(parseWorkPort('5432')).toEqual({
      hostPort: 5432,
      containerPort: 5432,
    })
  })

  it('should parse 5432:5433', () => {
    expect(parseWorkPort('5432:5433')).toEqual({
      hostPort: 5432,
      containerPort: 5433,
    })
  })
})
