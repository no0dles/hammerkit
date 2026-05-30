import { awaitState, isState } from './state-resolver'
import { State } from './state'
import { AbortError } from './abort'

type ABC = 'a' | 'b' | 'c'
describe('state-resolver', () => {
  it('should resolve state', async () => {
    const state = new State<ABC>('a')
    const isB = (val: ABC): val is 'b' => val === 'b'
    const result = isState('test-state', state, isB, new AbortController().signal)
    state.set('c')
    state.set('a')
    state.set('b')
    await result
  })

  it('should resolve state if already in', async () => {
    const state = new State<ABC>('b')
    const isB = (val: ABC): val is 'b' => val === 'b'
    await isState('test-state', state, isB, new AbortController().signal)
  })

  it('isState rejects with AbortError when aborted before the condition is met', async () => {
    const state = new State<ABC>('a')
    const isB = (val: ABC): val is 'b' => val === 'b'
    const abort = new AbortController()
    const result = isState('test-state', state, isB, abort.signal)
    abort.abort()
    await expect(result).rejects.toBeInstanceOf(AbortError)
  })

  it('awaitState rejects with AbortError when aborted before the condition is met', async () => {
    const state = new State<ABC>('a')
    const abort = new AbortController()
    const result = awaitState('test-state', state, (val) => val === 'b', abort.signal)
    abort.abort()
    await expect(result).rejects.toBeInstanceOf(AbortError)
  })
})
