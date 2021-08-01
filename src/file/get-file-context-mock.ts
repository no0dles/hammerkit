import { FileContextMock } from './file-context-mock'
import { FileWatcher, Stats } from './file-context'
import { sep } from 'path'

export type FilesystemNode = FilesystemDirectoryNode | FilesystemFileNode

export interface FilesystemDirectoryNode {
  type: 'directory'
  nodes: { [key: string]: FilesystemNode }
  listeners: FileWatchListener[]
}

export interface FilesystemFileNode {
  type: 'file'
  fileName: string
  content: string
  lastAccess: Date
  listeners: FileWatchListener[]
}

export interface FileWatchListener {
  callback: (fileName: string) => void
}

export function getFileContextMock(): FileContextMock {
  const rootNode: FilesystemDirectoryNode = {
    nodes: {},
    type: 'directory',
    listeners: [],
  }

  function getDirectoryNode(path: string[]): FilesystemDirectoryNode {
    let currentNode: FilesystemDirectoryNode = rootNode
    for (let i = 0; i < path.length; i++) {
      const nextNode = currentNode.nodes[path[i]]
      if (!nextNode || nextNode.type === 'file') {
        throw new Error(`unable to find directory ${path.slice(0, i).join(sep)}`)
      }
      currentNode = nextNode
    }

    return currentNode
  }

  function getFileNode(path: string[]): FilesystemFileNode {
    const lastPart = path[path.length - 1]
    const parentNode = getDirectoryNode(path.slice(0, path.length - 1))
    const node = parentNode.nodes[lastPart]

    if (!node || node.type === 'directory') {
      throw new Error(`unable to find file ${path}`)
    }
    return node
  }

  function getNode(path: string[]): FilesystemNode {
    const lastPart = path[path.length - 1]
    const parentNode = getDirectoryNode(path.slice(0, path.length - 1))
    const node = parentNode.nodes[lastPart]
    if (!node) {
      throw new Error(`unable to find path ${path}`)
    }
    return node
  }

  function cloneNode(node: FilesystemNode): FilesystemNode {
    if (node.type === 'directory') {
      return {
        nodes: Object.keys(node.nodes).reduce<{ [key: string]: FilesystemNode }>((map, nodeKey) => {
          map[nodeKey] = cloneNode(node.nodes[nodeKey])
          return map
        }, {}),
        listeners: [],
        type: 'directory',
      }
    } else {
      return {
        type: 'file',
        content: node.content,
        fileName: node.fileName,
        listeners: [],
        lastAccess: new Date(),
      }
    }
  }

  function notifyChange(path: string[], fileName: string) {
    let currentNode: FilesystemDirectoryNode = rootNode
    for (let i = 0; i < path.length; i++) {
      for (const listener of currentNode.listeners) {
        listener.callback(fileName)
      }
      const nextNode = currentNode.nodes[path[i]]
      if (nextNode.type === 'directory') {
        currentNode = nextNode
      } else {
        for (const listener of nextNode.listeners) {
          listener.callback(fileName)
        }
      }
    }
  }

  return {
    async appendFile(path: string, content: string): Promise<void> {
      const parts = path.split(sep)
      const fileNode = getFileNode(parts)
      fileNode.content += content
      fileNode.lastAccess = new Date()
      notifyChange(parts, path)
    },
    async createDirectory(path: string): Promise<void> {
      const parts = path.split(sep)
      let currentNode = rootNode
      for (let i = 0; i < parts.length; i++) {
        const nextNode = currentNode.nodes[parts[i]]
        if (!nextNode) {
          currentNode = currentNode.nodes[parts[i]] = {
            type: 'directory',
            nodes: {},
            listeners: [],
          }
        } else if (nextNode.type === 'file') {
          throw new Error(`unable to create directory ${parts.slice(0, i).join(sep)} because file already exists`)
        } else {
          currentNode = nextNode
        }
      }
      notifyChange(parts, path)
    },
    async copy(source: string, destination: string): Promise<void> {
      const destinationPath = destination.split(sep)
      const sourcePath = source.split(sep)
      const lastPart = destinationPath[destinationPath.length - 1]

      const sourceNode = getNode(sourcePath)
      const parentNode = getDirectoryNode(destinationPath.slice(0, destinationPath.length - 1))
      parentNode.nodes[lastPart] = cloneNode(sourceNode)
      notifyChange(destinationPath, destination)
    },
    async writeFile(path: string, content: string): Promise<void> {
      const parts = path.split(sep)
      const fileName = parts[parts.length - 1]

      const directoryNode = getDirectoryNode(parts.slice(0, parts.length - 1))
      directoryNode.nodes[fileName] = { type: 'file', content, lastAccess: new Date(), fileName: path, listeners: [] }
      notifyChange(parts, path)
    },
    async remove(path: string): Promise<void> {
      const parts = path.split(sep)
      let currentNode = rootNode
      for (let i = 0; i < parts.length - 1; i++) {
        const nextNode = currentNode.nodes[parts[i]]
        if (!nextNode || nextNode.type === 'file') {
          return
        }
        currentNode = nextNode
      }

      const lastPart = parts[parts.length - 1]
      delete currentNode.nodes[lastPart]
      notifyChange(parts, path)
    },
    watch(path: string, callback: (fileName: string) => void): FileWatcher {
      const node = getNode(path.split(sep))
      const listener: FileWatchListener = { callback }
      node.listeners.push(listener)
      return {
        close() {
          const index = node.listeners.indexOf(listener)
          if (index >= 0) {
            node.listeners.splice(index)
          }
        },
      }
    },
    async exists(path: string): Promise<boolean> {
      const parts = path.split(sep)
      let currentNode = rootNode
      for (let i = 0; i < parts.length - 1; i++) {
        const nextNode = currentNode.nodes[parts[i]]
        if (!nextNode || nextNode.type === 'file') {
          return false
        }
        currentNode = nextNode
      }
      return !!currentNode.nodes[parts[parts.length - 1]]
    },
    async listFiles(path: string): Promise<string[]> {
      const directoryNode = getDirectoryNode(path.split(sep))
      return Object.keys(directoryNode.nodes)
    },
    async stats(path: string): Promise<Stats> {
      const node = getNode(path.split(sep))
      if (node.type === 'file') {
        return { lastModified: node.lastAccess.getTime(), type: 'file' }
      } else {
        return { type: 'directory' }
      }
    },
    async read(path: string): Promise<string> {
      const fileNode = getFileNode(path.split(sep))
      return fileNode.content
    },
    async clear(): Promise<void> {
      rootNode.listeners = []
      rootNode.nodes = {}
    },
  }
}
