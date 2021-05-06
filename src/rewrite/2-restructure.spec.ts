import { restructure } from './2-restructure'
import { plan } from './1-plan'
import { join } from 'path'
import 'jest-extended'
import { ExecutionBuildFile, ExecutionBuildSource } from './0-parse'

describe('restructure', () => {
  const sourceFn = (src: string): ExecutionBuildSource => {
    return {
      relativePath: src,
      matcher: (file, cwd) => file.startsWith(join(cwd, src)),
    }
  }
  const npmBuild: ExecutionBuildFile = {
    fileName: '/home/user/build.npm.yaml',
    path: '/home/user',
    tasks: {
      install: {
        src: [sourceFn('package.json'), sourceFn('package-lock.json')],
        cmds: ['npm install'],
        shell: null,
        description: null,
        extend: null,
        generates: ['node_modules'],
        mounts: ['$PWD/.npm:/.npm', '$PWD/.config:/.config'],
        envs: {},
        image: 'node:14.16.0-alpine',
        deps: [],
        unknownProps: {},
      },
    },
    envs: {},
    includes: {},
    references: {},
  }
  const tscBuild: ExecutionBuildFile = {
    fileName: '/home/user/build.tsc.yaml',
    path: '/home/user',
    tasks: {
      build: {
        src: [sourceFn('tsconfig.json'), sourceFn('src')],
        cmds: ['node_modules/.bin/tsc -b'],
        shell: null,
        description: null,
        generates: ['dist'],
        extend: null,
        mounts: [],
        envs: {},
        image: 'node:14.16.0-alpine',
        deps: ['npm:install'],
        unknownProps: {},
      },
    },
    envs: {},
    includes: {
      npm: npmBuild,
    },
    references: {},
  }
  const projectA: ExecutionBuildFile = {
    fileName: '/home/user/pkg/a/build.yaml',
    path: '/home/user/pkg/a',
    tasks: {
      build: {
        extend: 'tsc:build',
        shell: null,
        description: null,
        cmds: [],
        src: [],
        deps: null,
        image: null,
        envs: {},
        mounts: [],
        generates: [],
        unknownProps: {},
      },
    },
    envs: {},
    includes: {
      tsc: tscBuild,
    },
    references: {},
  }
  const projectB: ExecutionBuildFile = {
    fileName: '/home/user/pkg/b/build.yaml',
    path: '/home/user/pkg/b',
    tasks: {
      build: {
        deps: ['a:build'],
        extend: 'tsc:build',
        shell: null,
        description: null,
        cmds: [],
        src: [],
        image: null,
        envs: {},
        mounts: [],
        generates: [],
        unknownProps: {},
      },
    },
    envs: {},
    includes: {
      tsc: tscBuild,
    },
    references: {
      a: projectA,
    },
  }
  const projectC: ExecutionBuildFile = {
    fileName: '/home/user/pkg/c/build.yaml',
    path: '/home/user/pkg/c',
    tasks: {
      build: {
        deps: ['b:build'],
        extend: 'tsc:build',
        shell: null,
        description: null,
        cmds: null,
        src: [],
        image: null,
        envs: {},
        mounts: [],
        generates: [],
        unknownProps: {},
      },
    },
    envs: {},
    includes: {
      tsc: tscBuild,
    },
    references: {
      b: projectB,
    },
  }
  const tree = restructure(plan(projectC, 'build'))

  it('should resolve dependencies', () => {
    expect(tree['/home/user/pkg/a:npm:install'].dependencies).toIncludeAllMembers([])
    expect(tree['/home/user/pkg/b:npm:install'].dependencies).toIncludeAllMembers([])
    expect(tree['/home/user/pkg/c:npm:install'].dependencies).toIncludeAllMembers([])
    expect(tree['/home/user/pkg/a:build'].dependencies).toIncludeAllMembers(['/home/user/pkg/a:npm:install'])
    expect(tree['/home/user/pkg/b:build'].dependencies).toIncludeAllMembers([
      '/home/user/pkg/b:npm:install',
      '/home/user/pkg/a:build',
      '/home/user/pkg/a:npm:install',
    ])
    expect(tree['/home/user/pkg/c:build'].dependencies).toIncludeAllMembers([
      '/home/user/pkg/a:npm:install',
      '/home/user/pkg/b:npm:install',
      '/home/user/pkg/c:npm:install',
      '/home/user/pkg/a:build',
      '/home/user/pkg/b:build',
    ])
  })

  it('should resolve sources', () => {
    expect(tree['/home/user/pkg/a:npm:install'].task.src.map((s) => s.absolutePath)).toIncludeAllMembers([
      '/home/user/pkg/a/package.json',
      '/home/user/pkg/a/package-lock.json',
    ])
    expect(tree['/home/user/pkg/b:npm:install'].task.src.map((s) => s.absolutePath)).toIncludeAllMembers([
      '/home/user/pkg/b/package.json',
      '/home/user/pkg/b/package-lock.json',
    ])
    expect(tree['/home/user/pkg/c:npm:install'].task.src.map((s) => s.absolutePath)).toIncludeAllMembers([
      '/home/user/pkg/c/package.json',
      '/home/user/pkg/c/package-lock.json',
    ])
    expect(tree['/home/user/pkg/a:build'].task.src.map((s) => s.absolutePath)).toIncludeAllMembers([
      '/home/user/pkg/a/package.json',
      '/home/user/pkg/a/package-lock.json',
      '/home/user/pkg/a/tsconfig.json',
    ])
    expect(tree['/home/user/pkg/b:build'].task.src.map((s) => s.absolutePath)).toIncludeAllMembers([
      '/home/user/pkg/b/package.json',
      '/home/user/pkg/b/package-lock.json',
      '/home/user/pkg/b/tsconfig.json',
      '/home/user/pkg/a/package.json',
      '/home/user/pkg/a/package-lock.json',
      '/home/user/pkg/a/tsconfig.json',
    ])
    expect(tree['/home/user/pkg/c:build'].task.src.map((s) => s.absolutePath)).toIncludeAllMembers([
      '/home/user/pkg/c/package.json',
      '/home/user/pkg/c/package-lock.json',
      '/home/user/pkg/c/tsconfig.json',
      '/home/user/pkg/b/package.json',
      '/home/user/pkg/b/package-lock.json',
      '/home/user/pkg/b/tsconfig.json',
      '/home/user/pkg/a/package.json',
      '/home/user/pkg/a/package-lock.json',
      '/home/user/pkg/a/tsconfig.json',
    ])
  })
})
