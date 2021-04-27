import {existsSync, readFileSync} from 'fs';
import {parse as yamlParse} from 'yaml';
import {dirname, join} from 'path';
import {Minimatch} from 'minimatch';

export interface ExecutionBuildFile {
  path: string
  envs: { [key: string]: string }
  tasks: { [key: string]: ExecutionBuildTask }
  references: { [key: string]: ExecutionBuildFile }
  includes: { [key: string]: ExecutionBuildFile }
}

export type ExecutionBuildTaskCmd =
  string
  | { type: 'cmd', cmd: string, path?: string };

export interface ExecutionBuildSource {
  relativePath: string
  matcher: (fileName: string, cwd: string) => boolean
}

export interface ExecutionBuildTask {
  deps: string[] | null
  src: ExecutionBuildSource[] | null
  description: string | null,
  shell: string | null
  generates: string[] | null
  extend: string | null
  image: string | null
  mounts: string[] | null
  cmds: ExecutionBuildTaskCmd[] | null;
  envs: { [key: string]: string } | null
}

export function read(fileName: string): any {
  let content: string;
  try {
    content = readFileSync(fileName).toString();
  } catch (e) {
    throw new Error(`unable to read ${fileName}`);
  }

  return yamlParse(content);
}

export function parse(fileName: string): ExecutionBuildFile {
  return readFile(fileName, {});
}

function loadEnvFile(path: string, baseEnv: { [key: string]: string }): { [key: string]: string } {
  const directory = join(path, '.env');
  if (!existsSync(directory)) {
    return baseEnv;
  }

  const envs = {...baseEnv};
  const envFile = readFileSync(directory).toString().split(/\r?\n/);
  for (const envVar of envFile) {
    const index = envVar.indexOf('=');
    if (index > 0) {
      const key = envVar.substr(0, index);
      const value = envVar.substr(index + 1);
      if (!envs[key]) {
        envs[key] = value;
      }
    }
  }

  return envs;
}

function readFile(fileName: string, files: { [key: string]: ExecutionBuildFile }): ExecutionBuildFile {
  const input = read(fileName);
  const result: ExecutionBuildFile = {
    includes: {},
    tasks: {},
    path: dirname(fileName),
    references: {},
    envs: {},
  };
  files[fileName] = result;

  result.includes = parseReferences('include', fileName, files, input.includes || {});
  result.references = parseReferences('reference', fileName, files, input.references || {});
  result.envs = parseEnvs(fileName, input.envs || {}) || {};
  result.envs = loadEnvFile(dirname(fileName), result.envs);

  if (input.tasks && typeof input.tasks !== 'object') {
    throw new Error(`${fileName} tasks need to be an object`);
  }

  for (const key of Object.keys(input.tasks || {})) {
    const value = input.tasks[key];
    result.tasks[key] = {
      envs: parseEnvs(fileName, value.envs || {}),
      mounts: parseStringArray(fileName, key, 'mounts', value.mounts),
      src: parseSources(fileName, key, value),
      deps: parseStringArray(fileName, key, 'deps', value.deps),
      generates: parseStringArray(fileName, key, 'generates', value.generates),
      description: value.description || null,
      image: value.image || null,
      extend: value.extend || null,
      shell: value.shell || null,
      cmds: parseCommands(fileName, key, value.cmds),
    };
  }

  return result;
}

function parseSources(fileName: string, key: string, value: any): ExecutionBuildSource[] | null {
  const sources = parseStringArray(fileName, key, 'src', value.src);
  if (!sources) {
    return null;
  }

  const result: ExecutionBuildSource[] = [];

  for (const source of sources) {
    const wildcardIndex = source.indexOf('*');
    if (wildcardIndex >= 0) {
      const matcher = new Minimatch(source, {dot: true});
      const matcherFn = (fileName: string) => {
        return matcher.match(fileName);
      };
      if (wildcardIndex === 0) {
        result.push({
          matcher: matcherFn,
          relativePath: '.',
        });
      } else {
        const prefixSource = source.substr(0, wildcardIndex);
        result.push({
          matcher: matcherFn,
          relativePath: prefixSource,
        });
      }
    } else {
      result.push({
        matcher: (file, cwd) => file.startsWith(join(cwd, source)),
        relativePath: source,
      });
    }
  }

  return result;
}

function parseCommands(fileName: string, taskName: string, value: any): ExecutionBuildTaskCmd[] | null {
  if (!value) {
    return null;
  }

  if (!(value instanceof Array)) {
    throw new Error(`${fileName} task ${taskName} cmds needs to be an array`);
  }

  return value.map<ExecutionBuildTaskCmd>(cmd => {
    if (typeof cmd === 'string') {
      return cmd;
    } else if (typeof cmd === 'object' && !!cmd.cmd) {
      if (!(typeof cmd.cmd === 'string')) {
        throw new Error(`${fileName} task ${taskName} cmd needs to be a string`);
      }

      if (cmd.path) {
        if (!(typeof cmd.path === 'string')) {
          throw new Error(`${fileName} task ${taskName} cmd path needs to be a string`);
        }
        return {cmd: cmd.cmd, path: cmd.path, type: 'cmd'};
      } else {
        return {cmd: cmd.cmd, type: 'cmd'};
      }
    } else {
      throw new Error(`${fileName} task ${taskName} unknown cmd`);
    }
  });
}

function parseStringArray(fileName: string, taskName: string, valueName: string, value: any): string[] | null {
  if (!value) {
    return null;
  }
  if (value instanceof Array) {
    if (!value.every(v => typeof v === 'string')) {
      throw new Error(`${fileName} task ${taskName} ${valueName} needs to be a string array`);
    }
    return value;
  } else {
    throw new Error(`${fileName} task ${taskName} ${valueName} needs to be a string array`);
  }
}

function parseReferences(type: string, fileName: string, files: { [key: string]: ExecutionBuildFile }, refs: any): { [key: string]: ExecutionBuildFile } {
  if (refs && typeof refs !== 'object') {
    throw new Error(`${fileName} references need to be an object`);
  }

  const result: { [key: string]: ExecutionBuildFile } = {};
  for (const key of Object.keys(refs)) {
    const value = refs[key];
    const referenceFileName = join(dirname(fileName), value);
    if (!existsSync(referenceFileName)) {
      throw new Error(`${fileName} ${type} ${key} not found`);
    }
    result[key] = readFile(referenceFileName, files);
  }
  return result;
}

function parseEnvs(fileName: string, envs: any): { [key: string]: string } | null {
  if (envs && typeof envs !== 'object') {
    throw new Error(`${fileName} envs need to be an object`);
  }

  if (!envs) {
    return null;
  }

  const result: { [key: string]: string } = {};
  for (const key of Object.keys(envs || {})) {
    const value = envs[key];
    if (typeof value === 'string') {
      result[key] = value;
    } else if (typeof value === 'number') {
      result[key] = value.toString();
    } else {
      throw new Error(`${fileName} envs ${key} need to be a string or number`);
    }
  }

  return result;
}
