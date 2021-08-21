import { getFileContextMock } from './get-file-context-mock'

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
    await new Promise<void>((resolve) => {
      const watch = ctx.watch('/home/user', (fileName) => {
        expect(fileName).toEqual('/home/user/test')
        watch.close()
        resolve()
      })
      ctx.appendFile('/home/user/test', 'def')
    })
  })

  it('should emit listener if directory below gets created', async () => {
    const ctx = getFileContextMock()
    await ctx.createDirectory('/home/user/repo')
    await new Promise<void>((resolve) => {
      const watch = ctx.watch('/home/user', (fileName) => {
        expect(fileName).toEqual('/home/user/repo/test')
        watch.close()
        resolve()
      })
      ctx.createDirectory('/home/user/repo/test')
    })
  })

  it('should not emit listener if directory above gets created', async () => {
    const ctx = getFileContextMock()
    await ctx.createDirectory('/home/user/repo')
    await new Promise<void>((resolve, reject) => {
      const watch = ctx.watch('/home/user', () => {
        watch.close()
        reject()
      })
      ctx.createDirectory('/home/test').then(() => {
        watch.close()
        resolve()
      })
    })
  })
})
