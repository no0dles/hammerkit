import { getFileContextMock } from './get-file-context-mock'
import { Defer } from '../utils/defer'

describe('file/get-file-context-mock', () => {
  it('should create directory', async () => {
    const ctx = getFileContextMock()
    await ctx.createDirectory('/home/user/repo')
    expect(await ctx.listFiles('/home/user')).toEqual(['repo'])
  })

  it('should list files', async () => {
    const ctx = getFileContextMock()
    await ctx.createDirectory('/home/user/repo')
    await ctx.writeFile('/home/user/test', 'abc')
    expect(await ctx.listFiles('/home/user')).toEqual(['repo', 'test'])
  })

  it('should emit listener if file below gets changed', async () => {
    const ctx = getFileContextMock()
    await ctx.createDirectory('/home/user/repo')
    await ctx.writeFile('/home/user/test', 'abc')
    const defer = new Defer<void>()
    const watch = ctx.watch('/home/user', (fileName) => {
      expect(fileName).toEqual('/home/user/test')
      defer.resolve()
    })
    await ctx.appendFile('/home/user/test', 'def')
    await defer.promise
    watch.close()
  })

  it('should emit listener if directory below gets created', async () => {
    const ctx = getFileContextMock()
    await ctx.createDirectory('/home/user/repo')
    const defer = new Defer<void>()
    const watch = ctx.watch('/home/user', (fileName) => {
      expect(fileName).toEqual('/home/user/repo/test')
      defer.resolve()
    })
    await ctx.createDirectory('/home/user/repo/test')
    await defer.promise
    watch.close()
  })

  it('should not emit listener if directory above gets created', async () => {
    const ctx = getFileContextMock()
    await ctx.createDirectory('/home/user/repo')
    const defer = new Defer<void>()
    const watch = ctx.watch('/home/user', () => {
      defer.reject()
    })
    await ctx.createDirectory('/home/test')
    defer.resolve()
    await defer.promise
    watch.close()
  })
})
