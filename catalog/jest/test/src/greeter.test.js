const { greet } = require('./greeter')

test('greets by name', () => {
  expect(greet('catalog')).toBe('hello catalog')
})
