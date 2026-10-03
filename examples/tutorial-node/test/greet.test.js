import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hello } from '../dist/greet.js'

test('greets by name', () => {
  assert.equal(hello('hammerkit'), 'Hello, hammerkit!')
})
