import { isState } from './state-resolver'
import { State } from './state'

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
})
