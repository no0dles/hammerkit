import {BuildFile} from '../../parser/build-file';
import {BaseWorkNode, ContainerWorkNode, LocalWorkNode, WorkNode} from '../work-node';
import {WorkContext} from '../work-context';
import {WorkNodes} from '../work-nodes';
import {templateValue} from './template-value';
import {planWorkCommand} from './plan-work-command';
import {splitName} from './split-name';
import {findBuildTask} from './find-build-task';
import {parseWorkNodeMount} from './parse-work-node-mount';
import {planWorkDependency} from './plan-work-dependency';
import {join} from 'path';
import {BuildFileTaskSource} from '../../parser/build-file-task-source';
import {WorkNodeSource} from '../work-node-source';
import {BuildFileTask} from '../../parser/build-file-task';
import {WorkNodeCommand} from '../work-node-command';
import {Defer} from '../../defer';
import {BuildTaskCommand} from '../../parser/build-file-task-command';
import {createReadStream, createWriteStream} from 'fs';
import {tmpdir} from 'os';

export interface MergedBuildFileTask {
  image: string | null
  envs: { [key: string]: string }
  cmds: BuildTaskCommand[]
  description: string | null
  shell: string | null
  unknownProps: { [key: string]: any }
  src: BuildFileTaskSource[]
  mounts: string[]
  generates: string[]
  continuous: boolean
}

export interface MergedDependency {
  build: BuildFile
  name: string
}

function getMergedBuildTask(
  build: BuildFile,
  task: BuildFileTask,
): { task: MergedBuildFileTask; deps: MergedDependency[] } {
  const envs = {
    ...build.envs,
    ...(task.envs || {}),
  };

  if (task.extend) {
    const extend = findBuildTask(build, task.extend);
    const extendEnvs = {
      ...extend.task.envs,
      ...envs,
    };
    return {
      task: {
        image: task.image || extend.task.image,
        envs: extendEnvs,
        cmds: task.cmds || extend.task.cmds || [],
        description: task.description || extend.task.description,
        shell: task.shell || extend.task.shell,
        continuous: task.continuous || extend.task.continuous || false,
        unknownProps: task.unknownProps,
        src: [...(extend.task.src || []), ...(task.src || [])],
        mounts: [...(extend.task.mounts || []), ...(task.mounts || [])],
        generates: [...(extend.task.generates || []), ...(task.generates || [])],
      },
      deps: [
        ...(extend.task.deps || []).map((d) => ({name: d, build: extend.build})),
        ...(task.deps || []).map((d) => ({name: d, build: build})),
      ],
    };
  } else {
    return {
      task: {
        image: task.image,
        src: task.src || [],
        cmds: task.cmds || [],
        continuous: task.continuous || false,
        generates: task.generates || [],
        description: task.description,
        shell: task.shell,
        unknownProps: task.unknownProps,
        mounts: task.mounts || [],
        envs,
      },
      deps: [...(task.deps || []).map((d) => ({name: d, build: build}))],
    };
  }
}

export function planWorkNode(build: BuildFile, taskName: string, nodes: WorkNodes, context: WorkContext): WorkNode {
  if (build.tasks[taskName]) {
    const id = `${context.currentWorkdir}:${context.idPrefix ? context.idPrefix + ':' : ''}${taskName}`;
    if (nodes[id]) {
      return nodes[id];
    }

    const {task, deps} = getMergedBuildTask(build, build.tasks[taskName]);
    const name = [...context.namePrefix, taskName].join(':');
    const node = parseWorkNode({
      envs: task.envs,
      id,
      continuous: task.continuous,
      description: templateValue(task.description, task.envs),
      name,
      cwd: context.currentWorkdir,
      cmds: parseWorkNodeCommand(task, context, task.envs),
      deps: [],
      unknownProps: task.unknownProps,
      buildFile: build,
      taskName: taskName,
      src: parseLocalWorkNodeSource(task, context, task.envs),
      generates: parseLocalWorkNodeGenerate(task, context, task.envs),
      status: {
        completedDependencies: {},
        pendingDependencies: {},
        state: {type: 'pending'},
        defer: new Defer<void>(),
        stdout: createWriteStream(join(tmpdir(), name + '.stdout')),
        stderr: createWriteStream(join(tmpdir(), name + '.stderr')),
        stdoutRead: () => createReadStream(join(tmpdir(), name + '.stdout')),
        stderrRead: () => createReadStream(join(tmpdir(), name + '.stderr')),
      },
    }, task, context);

    nodes[id] = node;

    for (const dep of deps) {
      planWorkDependency(dep.build, node, taskName, templateValue(dep.name, task.envs), nodes, context);
    }

    return node;
  } else {
    const ref = splitName(taskName);
    if (ref.prefix) {
      if (build.references[ref.prefix]) {
        return planWorkNode(build.references[ref.prefix], ref.taskName, nodes, {
          ...context,
          currentWorkdir: build.references[ref.prefix].path,
          idPrefix: null,
          namePrefix: [...context.namePrefix, ref.prefix],
        });
      } else if (build.includes[ref.prefix]) {
        return planWorkNode(build.includes[ref.prefix], ref.taskName, nodes, {
          ...context,
          idPrefix: ref.prefix,
          namePrefix: [...context.namePrefix, ref.prefix],
        });
      }
    }

    throw new Error(`unable to find ${taskName} in ${build.path}`);
  }
}

function parseWorkNode(baseWorkNode: BaseWorkNode, task: MergedBuildFileTask, context: WorkContext): WorkNode {
  if (task.image) {
    return {
      ...baseWorkNode,
      type: 'container',
      image: templateValue(task.image, task.envs),
      shell: templateValue(task.shell, task.envs) || 'sh',
      mounts: parseContainerWorkNodeMount(task, context, task.envs),
    };
  } else {
    return {
      ...baseWorkNode,
      type: 'local',
    };
  }
}

function parseContainerWorkNodeMount(
  task: MergedBuildFileTask,
  context: WorkContext,
  envs: { [key: string]: string } | null,
) {
  return task.mounts.map((m) => templateValue(m, envs)).map((m) => parseWorkNodeMount(context.currentWorkdir, m));
}

function parseLocalWorkNodeGenerate(
  task: MergedBuildFileTask,
  context: WorkContext,
  envs: { [key: string]: string } | null,
) {
  return getAbsolutePaths(task.generates, context.currentWorkdir).map((g) => templateValue(g, envs));
}

function parseLocalWorkNodeSource(
  task: MergedBuildFileTask,
  context: WorkContext,
  envs: { [key: string]: string } | null,
): WorkNodeSource[] {
  return task.src
    .map((src) => ({
      relativePath: templateValue(src.relativePath, envs),
      matcher: src.matcher,
    }))
    .map((src) => mapSource(src, context.currentWorkdir));
}

function parseWorkNodeCommand(
  task: MergedBuildFileTask,
  context: WorkContext,
  envs: { [key: string]: string } | null,
): WorkNodeCommand[] {
  return planWorkCommand(
    task.cmds.map((cmd) => {
      if (typeof cmd === 'string') {
        return templateValue(cmd, envs);
      } else {
        return {
          cmd: templateValue(cmd.cmd, envs),
          path: templateValue(cmd.path, envs),
          type: cmd.type,
        };
      }
    }),
    context.currentWorkdir,
  );
}

function mapSource(src: BuildFileTaskSource, workDir: string): WorkNodeSource {
  return {
    matcher: src.matcher,
    absolutePath: join(workDir, src.relativePath),
  };
}

function getAbsolutePaths(dirs: string[] | null, workingDir: string): string[] {
  if (!dirs) {
    return [];
  }
  return dirs.map((dir) => join(workingDir, dir));
}
