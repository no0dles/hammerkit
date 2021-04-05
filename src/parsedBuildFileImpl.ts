import {ParsedBuildFile} from './parsedBuildFile';
import {BuildFile, isDockerBuildFileTask} from './config';
import {BuildFileReference} from './buildFileReference';
import {ParsedReference} from './parsedReference';
import {parseBuildFile, ParsedTask} from './parse';
import {join, dirname} from 'path';
import {EnvMap, loadEnvFile, overrideEnv} from './env';
import {ParsedLocalTaskImpl} from './parsedLocalTaskImpl';
import {ParsedDockerTaskImpl} from './parsedDockerTaskImpl';
import {RunArg} from './run-arg';
import {BuildFileValidation} from './parsedBuildFileTask';

export class ParsedBuildFileImpl implements ParsedBuildFile {
  constructor(public fileName: string,
              private buildFile: BuildFile,
              private parentBuildFile: BuildFileReference | null) {
  }

  hasParent(buildFile: ParsedBuildFile): boolean {
    return !!this.parentBuildFile && (this.parentBuildFile.buildFile.fileName === buildFile.fileName || this.parentBuildFile.buildFile.hasParent(buildFile));
  }

  getPath(): string[] {
    if (this.parentBuildFile) {
      return [...this.parentBuildFile.buildFile.getPath(), this.parentBuildFile.name];
    } else {
      return [];
    }
  }

  async clean(): Promise<void> {
    for (const task of this.getTasks()) {
      await task.clean();
    }
  }

  async restore(directory: string): Promise<void> {
    for (const task of this.getTasks()) {
      await task.restore(directory);
    }
  }

  async store(directory: string): Promise<void> {
    for (const task of this.getTasks()) {
      await task.store(directory);
    }
  }

  * validate(arg: RunArg): Generator<BuildFileValidation> {
    for (const task of this.getTasks()) {
      for (const res of task.validate(arg)) {
        yield res;
      }
    }
    for (const ref of this.getReferences()) {
      for (const res of ref.buildFile.validate(arg)) { // TODO child?
        yield res;
      }
    }
    for (const include of this.getIncludes()) { // TODO child?
      for (const res of include.buildFile.validate(arg)) {
        yield res;
      }
    }
  }

  getEnvironmentVariables(arg: RunArg): EnvMap {
    let envs = this.parentBuildFile ? this.parentBuildFile.buildFile.getEnvironmentVariables(arg) : arg.envs;
    return overrideEnv(loadEnvFile(envs, dirname(this.fileName)), this.buildFile.envs);
  }

  getWorkingDirectory(): string {
    if (!this.parentBuildFile || this.parentBuildFile.type === 'reference') {
      return dirname(this.fileName);
    }
    return this.parentBuildFile.buildFile.getWorkingDirectory();
  }

  getInclude(name: string): ParsedReference | null {
    const includes = this.buildFile.includes || {};
    const include = includes[name];
    if (!include) {
      return null;
    }
    return {
      name,
      buildFile: parseBuildFile(join(dirname(this.fileName), include), {
        buildFile: this,
        type: 'include',
        name,
      }),
    };
  }

  * getIncludes(): Generator<ParsedReference> {
    const includes = this.buildFile.includes || {};
    for (const name of Object.keys(includes)) {
      yield {
        name,
        buildFile: parseBuildFile(join(dirname(this.fileName), includes[name]), {
          buildFile: this,
          type: 'include',
          name,
        }),
      };
    }
  }

  getReference(name: string): ParsedReference | null {
    const references = this.buildFile.references || {};
    const reference = references[name];
    if (!reference) {
      return null;
    }
    return {
      name,
      buildFile: parseBuildFile(join(dirname(this.fileName), reference), {
        buildFile: this,
        type: 'reference',
        name,
      }),
    };
  }

  * getReferences(): Generator<ParsedReference> {
    const references = this.buildFile.references || {};
    for (const name of Object.keys(references)) {
      yield {
        name,
        buildFile: parseBuildFile(join(dirname(this.fileName), references[name]), {
          buildFile: this,
          type: 'reference',
          name,
        }),
      };
    }
  }

  getTask(name: string): ParsedTask {
    const splitIndex = name.indexOf(':');
    if (splitIndex >= 0) {
      const prefix = name.substr(0, splitIndex);
      const taskName = name.substr(splitIndex + 1);
      const include = this.getInclude(prefix);
      if (include) {
        return include.buildFile.getTask(taskName);
      }

      const ref = this.getReference(prefix);
      if (ref) {
        return ref.buildFile.getTask(taskName);
      }
    } else {
      const tasks = this.buildFile.tasks || {};
      const task = tasks[name];
      if (task) {
        if (isDockerBuildFileTask(task)) {
          return new ParsedDockerTaskImpl(this, name, task);
        }
        return new ParsedLocalTaskImpl(this, name, task);
      }
    }

    throw new Error(`could not find task ${name}`);
  }

  * getTasks(): Generator<ParsedTask> {
    const tasks = this.buildFile.tasks || {};
    for (const name of Object.keys(tasks)) {
      const task = tasks[name];

      if (isDockerBuildFileTask(task)) {
        yield new ParsedDockerTaskImpl(this, name, task);
      }
      yield new ParsedLocalTaskImpl(this, name, task);
    }

    for (const ref of this.getReferences()) {
      if (ref.buildFile.hasParent(ref.buildFile)) {
        continue;
      }
      for (const task of ref.buildFile.getTasks()) {
        yield task;
      }
    }
  }
}
