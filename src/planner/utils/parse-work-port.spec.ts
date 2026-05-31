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

  it('throws for a port with more than two parts', () => {
    expect(() => parseWorkPort('1:2:3')).toThrow('invalid port 1:2:3')
  })

  it('throws for a non-numeric port', () => {
    expect(() => parseWorkPort('http')).toThrow('invalid port http')
  })
})
