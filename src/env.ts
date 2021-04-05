import {join} from 'path';
import {existsSync, readFileSync} from 'fs';

export function parseEnvs(): EnvMap {
  return new EnvMap({}, {...process.env});
}

export function overrideEnv(env: EnvMap, value?: { [key: string]: string }): EnvMap {
  const result = {...env.envs};
  const envs = value || {};
  for (const key of Object.keys(envs)) {
    const value = envs[key];
    if (value.startsWith('$')) {
      const processEnvValue = env.processEnvs[value.substr(1)];
      if (processEnvValue) {
        result[key] = processEnvValue;
      } else {
        throw new Error(`missing env ${value}`);
      }
    } else {
      result[key] = value;
    }
  }
  return new EnvMap(result, env.processEnvs);
}

export function loadEnvFile(env: EnvMap, path: string): EnvMap {
  const directory = join(path, '.env');
  const envs = {...env.envs};
  if (existsSync(directory)) {
    const envFile = readFileSync(directory).toString().split(/\r?\n/);
    for (const envVar of envFile) {
      const equalIndex = envVar.indexOf('=');
      if (equalIndex > 0) {
        envs[envVar.substr(0, equalIndex)] = envVar.substr(equalIndex + 1);
      }
    }
  }
  return new EnvMap(envs, env.processEnvs);
}

export class EnvMap {
  constructor(public envs: { [key: string]: string }, public processEnvs: { [key: string]: string | undefined | null }) {
  }

  asArray(): string[] {
    return Object.keys(this.envs).map(k => `${k}=${this.envs[k]}`);
  }

  escape(value: string): string {
    let result = value;
    for (const key of Object.keys(this.envs)) {
      const envValue = this.envs[key];
      result = result.replace(new RegExp(`\\$${key}`, 'gi'), envValue);
    }
    return result;
  }

  processEnv(): { [key: string]: string } {
    const envs = {...this.envs};
    for (const key of Object.keys(this.processEnvs)) {
      const value = this.processEnvs[key];
      if (!envs[key] && value) {
        envs[key] = value;
      }
    }
    return envs;
  }
}
