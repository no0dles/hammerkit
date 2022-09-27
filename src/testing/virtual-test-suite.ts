import { MockedTestCase, TestCase, TestSuite, TestSuiteSetupOptions } from './test-suite'
import { getFileContextMock } from '../file/get-file-context-mock'
import { TestEnvironment } from './test-environment'
import { getConsoleContextMock } from '../console/get-console-context-mock'
import { dirname, join } from 'path'
import { createBuildFile } from './create-build-file'
import { getTestCase } from './get-test-case'

export interface VirtualTestSuiteOptions {
  files: { [key: string]: string }
  buildFile: unknown
}

export function getVirtualTestSuite(virtualEnv: VirtualTestSuiteOptions): TestSuite {
  return new VirtualTestSuite(virtualEnv)
}

export class VirtualTestSuite implements TestSuite {
  constructor(private options: VirtualTestSuiteOptions) {}

  async close(): Promise<void> {
    return Promise.resolve()
  }

  setup(): Promise<TestCase>
  setup(options: Partial<TestSuiteSetupOptions>): Promise<MockedTestCase>
  async setup(options?: Partial<TestSuiteSetupOptions>): Promise<MockedTestCase | TestCase> {
    const cwd = '/home/test'
    const file = getFileContextMock()
    const environment: TestEnvironment = {
      processEnvs: { ...process.env },
      abortCtrl: new AbortController(),
      cwd,
      file,
      console: getConsoleContextMock(),
    }
    await file.createDirectory(cwd)
    for (const filePath in this.options.files) {
      await file.createDirectory(dirname(join(cwd, filePath)))
      await file.writeFile(join(cwd, filePath), this.options.files[filePath])
    }
    const buildFile = await createBuildFile(environment, this.options.buildFile)
    return getTestCase(buildFile, environment, options)
  }
}
