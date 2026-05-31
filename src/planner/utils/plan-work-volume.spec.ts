import { generateId, getContainerVolumes, getVolumeName } from './plan-work-volume'

describe('plan-work-volume', () => {
  describe('generateId / getVolumeName', () => {
    it('hashes the input deterministically (sha1)', () => {
      expect(generateId('a')).toBe(generateId('a'))
      expect(generateId('a')).not.toBe(generateId('b'))
      expect(getVolumeName('x')).toMatch(/^hammerkit-[a-f0-9]{40}$/)
    })
  })

  describe('getContainerVolumes', () => {
    const task = {
      generates: [
        { path: '/out/a', volumeName: 'na', inherited: null, resetOnChange: true, export: false, isFile: false },
        { path: '/out/b', volumeName: 'nb', inherited: null, resetOnChange: false, export: true, isFile: false },
      ],
    } as any

    it('emits a named volume for every generate that has no matching mount', () => {
      const volumes = getContainerVolumes(task, [])
      expect(volumes.map((v) => v.containerPath)).toEqual(['/out/a', '/out/b'])
      expect(volumes[0].resetOnChange).toBe(true)
      expect(volumes[1].export).toBe(true)
      expect(volumes[0].name).toMatch(/^hammerkit-/)
    })

    it('skips a generate whose path is already mounted (mount wins)', () => {
      const mounts = [{ containerPath: '/out/a' } as any]
      const volumes = getContainerVolumes(task, mounts)
      expect(volumes.map((v) => v.containerPath)).toEqual(['/out/b'])
    })
  })
})
