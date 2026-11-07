'use client';
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Container,
  Database,
  Globe,
  Hourglass,
  KeyRound,
  ListFilter,
  Lock,
  LoaderCircle,
  Moon,
  Radio,
  RotateCcw,
  Server,
  ShieldCheck,
  TimerOff,
  Vault,
  WifiOff,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { FeatureKey } from './features';

// One illustration per landing page point. Each shows the same work without and
// with hammerkit as columns side by side: per machine a row of task tiles that run,
// fail, are pulled from a shared cache that finished work is pushed to, or are
// verified against checks a hammerkit server recorded. A scene plays once, when it
// scrolls into view, and stops on its last frame. Times below are in minutes of
// work; `pace` is how many seconds of animation each minute takes.

type Span = { at: number; dur: number }; // minutes into the scene
// serve: a service that stays up; denied: refused, the caller may not use a secret it reads
// hold: a machine that is up, and uses compute, for its whole span
type Result = 'pass' | 'fail' | 'pulled' | 'verified' | 'serve' | 'hold' | 'denied';
// a badge on a task: a secret it holds, or how far its network reaches
// text: under the task; secret: the secret instance of the panel the task reads
type Tag = { icon: 'key' | 'open' | 'allow' | 'none'; tone: 'warn' | 'good' | 'plain'; text?: string; secret?: string };
// queued: waits until `at`; phases: what a service goes through once it is up
type Phase = { at: number; state: 'up' | 'asleep' | 'ended' };
// note: under a failed task; free: uses no compute of ours (an agent thinking or editing)
type Task = Span & {
  name: string;
  result: Result;
  queuedAt?: number;
  tag?: Tag;
  phases?: Phase[];
  note?: string;
  free?: boolean;
};
type Tone = 'plain' | 'warn' | 'good' | 'image'; // image: a container image
// something going between a lane and the hub, up to it unless `down`
type Link = Span & { words: [string, string]; down?: boolean }; // label while it goes, and after
// a dashed sandbox border where a limit is set: around all of the lane's tasks, or around each
// tile: a dashed outline around each tile only, which takes no room
type Boundary = { around: 'lane' | 'task' | 'tile'; tone: Tag['tone']; label?: string };
type Lane = { label: string; sub?: { text: string; tone: Tone }; tasks: Task[]; link?: Link; boundary?: Boundary };
type Hub = 'cache' | 'server';
// secrets: the secret instances the server keeps, linked to the tasks that read them
// cpu: the panel drawn as CPU use over time instead of its lanes, which still give its timing and totals
type Panel = {
  title?: string;
  lanes: Lane[];
  caption: string;
  hub?: Hub;
  secrets?: { id: string; label: string }[];
  cpu?: Cpu;
};
// CPU use from `from` to `to`, in vCPUs: `idle` between the bursts of the tasks that run, and
// `reserved` when a machine is held, and billed, for the whole time
type Cpu = {
  from: number;
  to: number;
  idle: number;
  reserved?: number;
  bursts: (Span & { label: string; level: number })[];
};
type Scene = {
  note: string;
  // in a panel's header: time from its first task starting to its last one done, and
  // compute, the runner time of all its tasks added up (in parallel, they add up)
  totals?: boolean | 'time'; // 'time': the time alone
  split?: string; // grid columns of the panels side by side, when they need other widths than equal
  laneTimers?: boolean; // time of each lane, under its label
  before: Panel;
  after: Panel;
  also?: Panel; // a second way with hammerkit
};

const pace = 2.5;
const pullTime = 0.25; // per task
const verifyTime = 0.05; // per task: a lookup, nothing moves
const pushTime = 0.3; // per lane
const recordTime = 0.1; // per lane

const node24 = { text: 'node:24', tone: 'image' } as const;

// the tasks an agent runs while it works: CPU for these, nothing in between
const agentBursts = [
  { label: 'install', at: 1.4, dur: 0.8, level: 3.2 },
  { label: 'test', at: 3.0, dur: 0.7, level: 2.6 },
];

// a key in every task of a place that holds all of them, or one secret a task was granted
const exposed: Tag = { icon: 'key', tone: 'warn' };
const granted = (secret: string): Tag => ({ icon: 'key', tone: 'good', secret });

const scenes: Record<FeatureKey, Scene> = {
  containers: {
    note: 'npm test on the same commit, on four machines',
    before: {
      lanes: [
        { label: 'dev machine', sub: { text: 'node 24.1', tone: 'plain' }, tasks: installTest(0.3, 'pass') },
        { label: 'teammate', sub: { text: 'node 22.11', tone: 'plain' }, tasks: installTest(0.4, 'pass') },
        { label: 'CI', sub: { text: 'node 20.9', tone: 'warn' }, tasks: installTest(0.5, 'fail') },
        { label: 'agent', sub: { text: 'node 18.20', tone: 'warn' }, tasks: installTest(0.6, 'fail') },
      ],
      caption: 'Works on my machine.',
    },
    after: {
      lanes: [
        { label: 'dev machine', sub: node24, tasks: installTest(0.3, 'pass') },
        { label: 'teammate', sub: node24, tasks: installTest(0.4, 'pass') },
        { label: 'CI', sub: node24, tasks: installTest(0.5, 'pass') },
        { label: 'agent', sub: node24, tasks: installTest(0.6, 'pass') },
      ],
      caption: 'Same image, same result.',
    },
  },
  cache: {
    note: 'one file changed: web/app.tsx',
    totals: true,
    before: {
      lanes: [
        { label: 'deps', sub: { text: 'unchanged', tone: 'plain' }, tasks: chain(0.3, [['install', 1.0]], 'pass') },
        { label: 'api', sub: { text: 'unchanged', tone: 'plain' }, tasks: buildTest(1.3, 'pass') },
        { label: 'web', sub: { text: 'changed', tone: 'warn' }, tasks: buildTest(1.3, 'pass') },
      ],
      caption: 'Everything runs again.',
    },
    after: {
      hub: 'cache',
      lanes: [
        { label: 'deps', sub: { text: 'unchanged', tone: 'plain' }, tasks: chain(0.3, [['install', 1.0]], 'pulled') },
        { label: 'api', sub: { text: 'unchanged', tone: 'plain' }, tasks: buildTest(0.3, 'pulled') },
        pushed({ label: 'web', sub: { text: 'changed', tone: 'warn' }, tasks: buildTest(0.55, 'pass') }),
      ],
      caption: 'Only what changed runs.',
    },
  },
  ci: {
    note: 'build and test before you push, then push the commit',
    laneTimers: true,
    before: {
      lanes: [
        { label: 'dev machine', tasks: installBuildTest(0.3, 'pass') },
        { label: 'CI', sub: { text: 'no cache', tone: 'warn' }, tasks: installBuildTest(2.8, 'pass') },
      ],
      caption: 'CI runs it all again.',
    },
    after: {
      title: 'With hammerkit · pull',
      hub: 'cache',
      lanes: [
        pushed({ label: 'dev machine', tasks: installBuildTest(0.3, 'pass') }),
        { label: 'CI', tasks: installBuildTest(2.8, 'pulled') },
      ],
      caption: 'CI pulls your results.',
    },
    also: {
      title: 'With hammerkit · verify',
      hub: 'server',
      lanes: [
        pushed(
          { label: 'sandbox', sub: { text: 'check run', tone: 'plain' }, tasks: installBuildTest(0.3, 'pass') },
          ['record', 'recorded'],
          recordTime
        ),
        { label: 'CI', tasks: installBuildTest(2.8, 'verified') },
      ],
      caption: 'CI verifies the checks passed, in seconds.',
    },
  },
  agents: {
    note: 'four agent sandboxes check the same commit',
    totals: true,
    laneTimers: true,
    before: {
      lanes: [
        { label: 'agent 1', tasks: buildTest(0.3, 'pass') },
        { label: 'agent 2', tasks: buildTest(2.4, 'pass') },
        { label: 'agent 3', tasks: buildTest(2.6, 'pass') },
        // two runners: agent 4 waits until agent 2 is done
        { label: 'agent 4', tasks: buildTest(4.1, 'pass', 2.8) },
      ],
      caption: 'Every agent builds from scratch.',
    },
    after: {
      hub: 'cache',
      lanes: [
        pushed({ label: 'agent 1', tasks: buildTest(0.3, 'pass') }),
        { label: 'agent 2', tasks: buildTest(2.4, 'pulled') },
        { label: 'agent 3', tasks: buildTest(2.6, 'pulled') },
        { label: 'agent 4', tasks: buildTest(2.8, 'pulled') },
      ],
      caption: 'One builds, the others pull it.',
    },
  },
  secrets: {
    note: 'a developer, an agent and CI work on the same repository',
    split: 'sm:grid-cols-[2fr_3fr]',
    before: {
      lanes: [
        {
          label: 'dev machine',
          boundary: { around: 'lane', tone: 'warn', label: '.env with every key' },
          tasks: keyed(installDeploy(0.3), { install: exposed, deploy: exposed }),
        },
        {
          label: 'agent sandbox',
          boundary: { around: 'lane', tone: 'warn', label: 'its own copy' },
          tasks: keyed(installDeploy(0.5), { install: exposed, deploy: exposed }),
        },
        {
          label: 'CI',
          boundary: { around: 'lane', tone: 'warn', label: 'job secrets' },
          tasks: keyed(installTestDeploy(0.7), { install: exposed, test: exposed, deploy: exposed }),
        },
      ],
      caption: 'Three copies of every key, and the agent can deploy.',
    },
    after: {
      secrets: [
        { id: 'read', label: 'npm read' },
        { id: 'deploy', label: 'deploy key' },
      ],
      lanes: [
        {
          label: 'dev machine',
          boundary: { around: 'tile', tone: 'good' },
          tasks: keyed(installDeploy(0.3), { install: granted('read'), deploy: granted('deploy') }),
        },
        {
          label: 'agent sandbox',
          boundary: { around: 'tile', tone: 'good' },
          tasks: [
            ...keyed(chain(0.5, [['install', 0.8]], 'pass'), { install: granted('read') }),
            {
              name: 'deploy',
              at: 1.3,
              dur: 0.1,
              result: 'denied',
              tag: { icon: 'key', tone: 'warn', secret: 'deploy' },
            },
          ],
        },
        {
          label: 'CI',
          boundary: { around: 'tile', tone: 'good' },
          tasks: keyed(installTestDeploy(0.7), { install: granted('read'), deploy: granted('deploy') }),
        },
      ],
      caption: 'The keys stay on the server, and the agent may not read the deploy key.',
    },
  },
  network: {
    note: 'install, test and deploy in one pipeline',
    before: {
      lanes: [
        {
          label: 'CI job',
          sub: { text: 'one runner for every step', tone: 'plain' },
          boundary: { around: 'lane', tone: 'warn', label: 'open network' },
          tasks: tagged(installTestDeploy(0.3), { icon: 'open', tone: 'warn' }),
        },
      ],
      caption: 'Every step reaches everything.',
    },
    after: {
      lanes: [
        {
          label: 'CI job',
          sub: { text: 'a limit per task', tone: 'good' },
          boundary: { around: 'task', tone: 'good' },
          tasks: tagged(
            tagged(
              tagged(installTestDeploy(0.3), { icon: 'allow', tone: 'good', text: 'npm' }, ['install']),
              { icon: 'none', tone: 'good', text: 'none' },
              ['test']
            ),
            { icon: 'allow', tone: 'good', text: 'hosting.example.com' },
            ['deploy']
          ),
        },
      ],
      caption: 'Each step reaches only what it needs.',
    },
  },
  remote: {
    note: 'four worktrees build and test at the same time',
    totals: 'time',
    before: {
      lanes: [
        { label: 'worktree 1', sub: { text: 'on your dev machine', tone: 'warn' }, tasks: crowded(0.3) },
        { label: 'worktree 2', sub: { text: 'on your dev machine', tone: 'warn' }, tasks: crowded(0.4) },
        // the dev machine has room for two: these wait for the first two
        { label: 'worktree 3', sub: { text: 'on your dev machine', tone: 'warn' }, tasks: crowded(2.3, 0.5) },
        { label: 'worktree 4', sub: { text: 'on your dev machine', tone: 'warn' }, tasks: crowded(2.4, 0.6) },
      ],
      caption: 'They share one dev machine and wait for each other.',
    },
    after: {
      hub: 'server',
      lanes: [0.3, 0.35, 0.4, 0.45].map((at, i) => ({
        label: `worktree ${i + 1}`,
        sub: { text: 'on the server', tone: 'good' as const },
        tasks: buildTest(at + 0.15, 'pass'),
        link: { at, dur: 0.1, words: ['submit', 'submitted'] as [string, string] },
      })),
      caption: 'Each runs on the server, all at once; your dev machine stays free.',
    },
  },
  sandbox: {
    note: 'a coding agent works on a fix',
    totals: true,
    before: {
      cpu: { from: 0.3, to: 4.0, idle: 0.3, reserved: 4, bursts: agentBursts },
      lanes: [
        { label: 'agent', tasks: agentSteps() },
        { label: 'agent VM', tasks: [{ name: 'vm', at: 0.3, dur: 3.7, result: 'hold' }] },
      ],
      caption: 'Its VM is reserved, and billed, while the agent only thinks.',
    },
    after: {
      cpu: { from: 0.3, to: 4.0, idle: 0, bursts: agentBursts },
      lanes: [
        { label: 'agent', tasks: agentSteps() },
        {
          label: 'sandbox',
          tasks: agentBursts.map(({ label, at, dur }) => ({ name: label, at, dur, result: 'pass' as const })),
        },
      ],
      caption: 'Compute only while a task runs; between runs, just its files.',
    },
  },
  preview: {
    note: 'preview three worktrees at the same time',
    before: {
      lanes: [
        { label: 'worktree 1', sub: { text: 'feat1', tone: 'plain' }, tasks: localStack(0.3, true) },
        { label: 'worktree 2', sub: { text: 'feat2', tone: 'plain' }, tasks: localStack(0.4, false) },
        { label: 'worktree 3', sub: { text: 'feat3', tone: 'plain' }, tasks: localStack(0.5, false) },
      ],
      caption: 'One stack at a time: the others find its ports taken.',
    },
    after: {
      hub: 'server',
      lanes: [
        previewLane(1, 'feat1', 0.3, [{ at: 2.8, state: 'asleep' }]),
        previewLane(2, 'feat2', 0.4, [
          { at: 2.6, state: 'asleep' },
          { at: 3.3, state: 'up' },
        ]),
        previewLane(3, 'feat3', 0.5, [
          { at: 2.7, state: 'asleep' },
          { at: 3.6, state: 'ended' },
        ]),
      ],
      caption: 'Each at its own URL; idle ones sleep, old ones end.',
    },
  },
};

// Tasks one after the other from `at`: run for their own time, pulled, or verified.
function chain(at: number, steps: [string, number][], result: Result, queuedAt?: number): Task[] {
  let start = at;
  return steps.map(([name, runTime], i) => {
    const dur = result === 'pulled' ? pullTime : result === 'verified' ? verifyTime : runTime;
    const task: Task = {
      name,
      at: start,
      dur,
      // a failing chain fails at its last task
      result: result === 'fail' && i < steps.length - 1 ? 'pass' : result,
      ...(i === 0 && queuedAt !== undefined ? { queuedAt } : {}),
    };
    start += dur;
    return task;
  });
}

function installTest(at: number, result: Result) {
  return chain(
    at,
    [
      ['install', 0.8],
      ['test', 0.9],
    ],
    result
  );
}

function installBuildTest(at: number, result: Result) {
  return chain(
    at,
    [
      ['install', 0.8],
      ['build', 0.7],
      ['test', 0.6],
    ],
    result
  );
}

function buildTest(at: number, result: Result, queuedAt?: number) {
  return chain(
    at,
    [
      ['build', 1.0],
      ['test', 0.7],
    ],
    result,
    queuedAt
  );
}

function keyed(tasks: Task[], tags: Record<string, Tag>): Task[] {
  return tasks.map((task) => (tags[task.name] ? { ...task, tag: tags[task.name] } : task));
}

function installDeploy(at: number) {
  return chain(
    at,
    [
      ['install', 0.8],
      ['deploy', 0.5],
    ],
    'pass'
  );
}

function installTestDeploy(at: number) {
  return chain(
    at,
    [
      ['install', 0.8],
      ['test', 0.9],
      ['deploy', 0.6],
    ],
    'pass'
  );
}

// build a worktree and bring its web up on the dev machine: only the first gets the port
function localStack(at: number, first: boolean): Task[] {
  return [
    { name: 'build', at, dur: 0.9, result: 'pass' },
    first
      ? { name: 'web', at: at + 0.9, dur: 0.1, result: 'serve' }
      : { name: 'web', at: at + 0.9, dur: 0.1, result: 'fail', note: 'port in use' },
  ];
}

// a worktree's preview on the server: built, up at a URL of its own, then sleeping, waking or ending
function previewLane(n: number, name: string, at: number, phases: Phase[]): Lane {
  return {
    label: `worktree ${n}`,
    sub: { text: `${name}.run.example.com`, tone: 'good' },
    tasks: [
      { name: 'build', at, dur: 0.9, result: 'pass' },
      { name: 'web', at: at + 0.9, dur: 0.1, result: 'serve', phases },
    ],
    link: { at: at + 1.0, dur: 0.15, words: ['url', 'url'], down: true },
  };
}

// what the agent does itself: no compute of ours
function agentSteps(): Task[] {
  return [
    { name: 'think', at: 0.3, dur: 0.8, result: 'pass', free: true },
    { name: 'edit', at: 1.1, dur: 0.3, result: 'pass', free: true },
    { name: 'think', at: 2.2, dur: 0.8, result: 'pass', free: true },
    { name: 'edit', at: 3.7, dur: 0.3, result: 'pass', free: true },
  ];
}

// build and test slowed down by the other worktrees on the same dev machine
function crowded(at: number, queuedAt?: number) {
  return chain(
    at,
    [
      ['build', 1.2],
      ['test', 0.8],
    ],
    'pass',
    queuedAt
  );
}

function editInstallTest(at: number) {
  return chain(
    at,
    [
      ['edit', 0.6],
      ['install', 0.8],
      ['test', 0.8],
    ],
    'pass'
  );
}

// Once its last task is done, the lane pushes its results to the cache (or the
// server records the check run).
function pushed(lane: Lane, words: [string, string] = ['push', 'pushed'], dur = pushTime): Lane {
  return { ...lane, link: { at: Math.max(...lane.tasks.map(end)), dur, words } };
}

function tagged(tasks: Task[], tag: Tag, names?: string[]): Task[] {
  return tasks.map((task) => (names === undefined || names.includes(task.name) ? { ...task, tag } : task));
}

// a declaration, so `pushed` can use it while `scenes` is built above
function end(span: Span) {
  return span.at + span.dur;
}

const spansOf = (lane: Lane) => (lane.link ? [...lane.tasks, lane.link] : lane.tasks);
const panelEnd = (panel: Panel) =>
  Math.max(
    ...panel.lanes.flatMap(spansOf).map(end),
    ...panel.lanes.flatMap((lane) => lane.tasks.flatMap((task) => task.phases?.map((phase) => phase.at + 0.3) ?? []))
  );
const panelsOf = (scene: Scene) => (scene.also ? [scene.before, scene.after, scene.also] : [scene.before, scene.after]);
const sceneEnd = (scene: Scene) => Math.max(...panelsOf(scene).map(panelEnd));
const clamp = (value: number) => Math.min(Math.max(value, 0), 1);
const metered = (spans: Span[]) => spans.filter((span) => !('free' in span && span.free));
const elapsed = (spans: Span[], t: number) =>
  spans.reduce((sum, span) => sum + Math.min(Math.max(t - span.at, 0), span.dur), 0);
// how long the panel has been at work: from its first start until now, or until it was done
function waited(panel: Panel, t: number) {
  const first = Math.min(...panel.lanes.flatMap(spansOf).map((span) => span.at));
  return Math.max(Math.min(t, panelEnd(panel)) - first, 0);
}

function minutes(value: number) {
  const total = Math.round(value * 60);
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
}

// What goes between a lane and the hub: its link, its pulled tasks (towards the
// lane), or the lookups of its verified tasks.
function transferOf(lane: Lane): { toHub: boolean; spans: Span[]; words: [string, string] } | undefined {
  if (lane.link) return { toHub: !lane.link.down, spans: [lane.link], words: lane.link.words };
  const pulls = lane.tasks.filter((task) => task.result === 'pulled');
  if (pulls.length > 0) return { toHub: false, spans: pulls, words: ['pull', 'pulled'] };
  const lookups = lane.tasks.filter((task) => task.result === 'verified');
  if (lookups.length > 0) return { toHub: true, spans: lookups, words: ['verify', 'verified'] };
  return undefined;
}

type State =
  | 'idle'
  | 'queued'
  | 'running'
  | 'pass'
  | 'fail'
  | 'pulling'
  | 'pulled'
  | 'verified'
  | 'serving'
  | 'asleep'
  | 'ended'
  | 'denied';

function stateOf(task: Task, t: number): { state: State; progress: number } {
  const progress = clamp((t - task.at) / task.dur);
  if (t < task.at) return { state: task.queuedAt !== undefined && t >= task.queuedAt ? 'queued' : 'idle', progress: 0 };
  if (task.result === 'verified') return { state: 'verified', progress: 1 };
  if (task.result === 'denied') return { state: 'denied', progress: 1 };
  if (task.result === 'pulled') return { state: progress < 1 ? 'pulling' : 'pulled', progress };
  if (task.result === 'hold') return { state: 'serving', progress: 1 };
  if (progress < 1) return { state: 'running', progress };
  if (task.result === 'serve') {
    const phase = task.phases?.filter((p) => t >= p.at).at(-1)?.state ?? 'up';
    return { state: phase === 'up' ? 'serving' : phase, progress: 1 };
  }
  return { state: task.result === 'fail' ? 'fail' : 'pass', progress: 1 };
}

// The lane's transfer once it has started: going on, or done.
function transferAt(lane: Lane, t: number) {
  const transfer = transferOf(lane);
  if (!transfer) return undefined;
  const active = transfer.spans.some((span) => t >= span.at && t < end(span));
  const done = t >= Math.max(...transfer.spans.map(end));
  if (!active && !done) return undefined;
  return { toHub: transfer.toHub, active, word: transfer.words[active ? 0 : 1] };
}

function hubAt(panel: Panel, t: number) {
  const spans = panel.lanes.flatMap((lane) => transferOf(lane)?.spans ?? []);
  return {
    active: spans.some((span) => t >= span.at && t < end(span)),
    used: spans.some((span) => t >= span.at),
  };
}

const hubs: Record<Hub, { icon: LucideIcon; name: string }> = {
  cache: { icon: Database, name: 'shared cache' },
  server: { icon: Server, name: 'hammerkit server' },
};

const titleOf = (panel: Panel, i: number) => panel.title ?? (i === 0 ? 'Without hammerkit' : 'With hammerkit');

const tiles: Record<State, { look: string; icon?: LucideIcon; spin?: boolean }> = {
  idle: { look: 'bg-white/[0.06]' },
  queued: { look: 'bg-amber-300/15 text-amber-200', icon: Hourglass },
  running: { look: 'bg-sky-400/15 text-white', icon: LoaderCircle, spin: true },
  pass: { look: 'bg-sky-400/70 text-zinc-950', icon: Check },
  fail: { look: 'bg-red-400/85 text-zinc-950', icon: X },
  pulling: { look: 'bg-emerald-400/15 text-emerald-100', icon: ArrowDown },
  pulled: { look: 'bg-emerald-400 text-zinc-950', icon: Zap },
  verified: { look: 'bg-emerald-400 text-zinc-950', icon: ShieldCheck },
  serving: { look: 'bg-sky-400/70 text-zinc-950', icon: Radio },
  asleep: { look: 'bg-sky-400/15 text-sky-200/70', icon: Moon },
  ended: { look: 'bg-white/[0.04] text-white/35', icon: TimerOff },
  denied: { look: 'bg-red-400/15 text-red-300', icon: Lock },
};

const tagIcons: Record<Tag['icon'], LucideIcon> = { key: KeyRound, open: Globe, allow: ListFilter, none: WifiOff };
const tagTones: Record<Tag['tone'], string> = {
  warn: 'bg-amber-300 text-zinc-950',
  good: 'bg-emerald-400 text-zinc-950',
  plain: 'bg-white/70 text-zinc-950',
};
const toneText: Record<Tag['tone'], string> = {
  warn: 'text-amber-300/90',
  good: 'text-emerald-300/90',
  plain: 'text-white/45',
};
const serviceWords: Partial<Record<State, string>> = { serving: 'up', asleep: 'asleep', ended: 'ended' };

const toneOutline: Record<Tag['tone'], string> = {
  warn: 'outline-amber-300/50',
  good: 'outline-emerald-400/50',
  plain: 'outline-white/25',
};
const toneBorder: Record<Tag['tone'], string> = {
  warn: 'border-amber-300/50',
  good: 'border-emerald-400/50',
  plain: 'border-white/25',
};

// wide: may grow past the tile for a long label, inside a border of its own
// link: the key a line from the task's secret ends at
function Tile({
  task,
  t,
  wide = false,
  link,
  outline,
}: {
  task: Task;
  t: number;
  wide?: boolean;
  link?: string;
  outline?: string;
}) {
  const { state, progress } = stateOf(task, t);
  const { look, icon: Icon, spin } = tiles[state];
  const TagIcon = task.tag ? tagIcons[task.tag.icon] : undefined;
  return (
    <div className={`flex flex-col items-center gap-1 ${wide ? 'min-w-9' : 'w-9'}`}>
      <div className="relative">
        <div
          data-link={link}
          className={`relative flex size-8 items-center justify-center overflow-hidden rounded-md transition-colors duration-300 ${look} ${
            outline ?? ''
          }`}
        >
          {/* a run fills up from the bottom, a pull comes down from the top */}
          {state === 'running' && (
            <div className="absolute inset-x-0 bottom-0 bg-sky-400/45" style={{ height: `${progress * 100}%` }} />
          )}
          {state === 'pulling' && (
            <div className="absolute inset-x-0 top-0 bg-emerald-400/55" style={{ height: `${progress * 100}%` }} />
          )}
          {Icon && <Icon className={`relative size-3.5 ${spin ? 'animate-spin' : ''}`} />}
        </div>
        {task.tag && TagIcon && state !== 'denied' && (
          <span
            className={`absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full ring-2 ring-zinc-950 ${
              tagTones[task.tag.tone]
            }`}
          >
            <TagIcon className="size-2.5" />
          </span>
        )}
      </div>
      <span className="whitespace-nowrap text-[9px] text-white/45">{task.name}</span>
      {state === 'denied' && <span className="-mt-1 whitespace-nowrap text-[8px] text-red-300/90">no access</span>}
      {state === 'fail' && task.note && (
        <span className="-mt-1 whitespace-nowrap text-[8px] text-red-300/90">{task.note}</span>
      )}
      {(task.result === 'serve' || task.result === 'hold') && serviceWords[state] && (
        <span
          className={`-mt-1 whitespace-nowrap text-[8px] ${state === 'serving' ? 'text-sky-300/90' : 'text-white/45'}`}
        >
          {serviceWords[state]}
        </span>
      )}
      {task.tag?.text && (
        <span className={`-mt-1 whitespace-nowrap text-[8px] ${toneText[task.tag.tone]}`}>{task.tag.text}</span>
      )}
    </div>
  );
}

const subTones: Record<Tone, string> = {
  plain: 'text-white/40',
  warn: 'text-amber-300/90',
  good: 'text-emerald-300/90',
  image: 'text-emerald-300/90',
};

function Tiles({ lane, index, t }: { lane: Lane; index: number; t: number }) {
  const boundary = lane.boundary;
  const link = (task: Task, i: number) => (task.tag?.secret ? linkKey(index, i) : undefined);
  if (boundary?.around === 'task') {
    return (
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {lane.tasks.map((task, i) => (
          <div key={i} className={`rounded-lg border border-dashed px-1.5 pb-1 pt-2 ${toneBorder[boundary.tone]}`}>
            <Tile task={task} t={t} wide link={link(task, i)} />
          </div>
        ))}
      </div>
    );
  }
  const outline =
    boundary?.around === 'tile' ? `outline-1 outline-offset-3 outline-dashed ${toneOutline[boundary.tone]}` : undefined;
  const tiles = lane.tasks.map((task, i) => <Tile key={i} task={task} t={t} link={link(task, i)} outline={outline} />);
  if (boundary?.around === 'lane') {
    return (
      // the label sits on the top edge and takes part in the width, so a short row of tiles can't squeeze it
      <div
        className={`mt-4 inline-flex flex-col rounded-lg border border-dashed px-2 pb-1.5 ${toneBorder[boundary.tone]}`}
      >
        <span
          className={`-mt-2 mb-1 w-max whitespace-nowrap bg-zinc-950 px-1 text-[9px] leading-4 ${
            toneText[boundary.tone]
          }`}
        >
          {boundary.label ?? ' '}
        </span>
        <div className="flex gap-1.5 pt-1">{tiles}</div>
      </div>
    );
  }
  return <div className="mt-2.5 flex gap-1.5">{tiles}</div>;
}

const linkKey = (lane: number, task: number) => `${lane}:${task}`;

function LaneView({ lane, index, t, timer }: { lane: Lane; index: number; t: number; timer: boolean }) {
  const transfer = transferAt(lane, t);
  // the hub sits above the lanes: towards it is up
  const Arrow = transfer?.toHub ? ArrowUp : ArrowDown;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-white/80">{lane.label}</span>
        {timer && (
          <span className="shrink-0 tabular-nums text-white/45">{minutes(elapsed(metered(spansOf(lane)), t))}</span>
        )}
      </div>
      <div className="flex h-3.5 items-center justify-between gap-2 text-[10px]">
        <span className={`flex items-center gap-1 truncate ${lane.sub ? subTones[lane.sub.tone] : ''}`}>
          {lane.sub?.tone === 'image' && <Container className="size-2.5 shrink-0" />}
          {lane.sub?.text}
        </span>
        {transfer && (
          <span
            className={`flex shrink-0 items-center gap-0.5 text-emerald-300 ${transfer.active ? 'animate-pulse' : ''}`}
          >
            <Arrow className="size-2.5" />
            {transfer.word}
          </span>
        )}
      </div>
      {lane.tasks.length > 0 && <Tiles lane={lane} index={index} t={t} />}
    </div>
  );
}

// A line from a secret in the vault to a task that reads it: out of the vault to the left, along
// a channel of its own between the tasks and the vault, then left just above the task's row and
// down into the task. So it never runs over another task.
type Line = { sx: number; sy: number; channel: number; row: number; ex: number; ey: number };

// Measured in the column's own box, and again whenever the column changes size.
function useSecretLines(root: RefObject<HTMLDivElement | null>, panel: Panel) {
  const [lines, setLines] = useState<Record<string, Line>>({});
  const secrets = panel.secrets;
  useEffect(() => {
    const element = root.current;
    const vault = element?.querySelector('[data-vault]');
    if (!element || !vault || !secrets) return;
    const measure = () => {
      const box = element.getBoundingClientRect();
      const vaultLeft = vault.getBoundingClientRect().left - box.left;
      const next: Record<string, Line> = {};
      panel.lanes.forEach((lane, li) =>
        lane.tasks.forEach((task, ti) => {
          const key = linkKey(li, ti);
          const k = secrets.findIndex((secret) => secret.id === task.tag?.secret);
          const tile = element.querySelector(`[data-link="${key}"]`);
          const chip = k >= 0 && element.querySelector(`[data-secret="${secrets[k].id}"]`);
          if (!tile || !chip) return;
          const from = chip.getBoundingClientRect();
          const to = tile.getBoundingClientRect();
          // the lower a secret sits in the vault, the closer its channel runs to it and the lower
          // above a row it turns: no two lines cross
          const outer = secrets.length - 1 - k;
          next[key] = {
            sx: from.left - box.left,
            sy: from.top + from.height / 2 - box.top,
            channel: vaultLeft - 8 - outer * 6,
            row: to.top - box.top - 10 - outer * 4,
            ex: to.left + to.width / 2 - box.left,
            ey: to.top - box.top - 4,
          };
        })
      );
      setLines(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [root, panel, secrets]);
  return lines;
}

// Granted reads are green, a refused one is red and dashed. A line lights up when its task starts.
function SecretLines({ panel, lines, t }: { panel: Panel; lines: Record<string, Line>; t: number }) {
  return (
    <svg aria-hidden className="pointer-events-none absolute inset-0 -z-10 h-full w-full overflow-visible">
      {panel.lanes.flatMap((lane, li) =>
        lane.tasks.map((task, ti) => {
          const key = linkKey(li, ti);
          const line = lines[key];
          if (!line) return null;
          const started = t >= task.at;
          const refused = task.result === 'denied';
          return (
            <g key={key} className="transition-opacity duration-300" style={{ opacity: started ? 1 : 0.15 }}>
              <path
                d={`M ${line.sx} ${line.sy} H ${line.channel} V ${line.row} H ${line.ex} V ${line.ey}`}
                fill="none"
                strokeWidth={1.25}
                strokeLinejoin="round"
                strokeDasharray={refused ? '3 3' : undefined}
                className={refused ? 'stroke-red-400/80' : 'stroke-emerald-400/60'}
              />
              {refused && started && (
                <g transform={`translate(${line.ex + 10} ${line.row})`}>
                  <circle r={6} className="fill-red-400" />
                  <path d="M -2.5 -2.5 L 2.5 2.5 M 2.5 -2.5 L -2.5 2.5" strokeWidth={1.5} className="stroke-zinc-950" />
                </g>
              )}
            </g>
          );
        })
      )}
    </svg>
  );
}

// The server and the vault it reads the secrets from, beside the tasks.
function SecretVault({ secrets }: { secrets: NonNullable<Panel['secrets']> }) {
  return (
    <div className="flex w-[5.75rem] shrink-0 flex-col gap-1.5 self-center">
      <div className="flex items-start gap-1 text-[10px] leading-tight text-emerald-300/80">
        <Server className="mt-px size-3 shrink-0" />
        hammerkit server
      </div>
      <div data-vault className="rounded-lg px-1.5 py-1.5 ring-1 ring-white/15">
        <div className="flex items-center gap-1 text-[10px] text-white/70">
          <Vault className="size-3" />
          vault
        </div>
        <div className="mb-1.5 text-[8px] text-white/40">1Password · GSM</div>
        <div className="flex flex-col gap-1.5">
          {secrets.map((secret) => (
            <span
              key={secret.id}
              data-secret={secret.id}
              className="flex items-center gap-1 whitespace-nowrap rounded-md bg-emerald-400/10 px-1 py-0.5 text-[9px] text-emerald-200 ring-1 ring-emerald-400/30"
            >
              <KeyRound className="size-2.5 shrink-0" />
              {secret.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

const chart = { width: 240, height: 100, top: 12, max: 4 }; // viewBox units; vCPUs at the top line

// CPU use over time on one scale for every panel, revealed up to `t`. A reserved machine is a
// washed band up to its capacity: what is billed. The line is what the tasks use.
function CpuChart({ cpu, t, hammerkit }: { cpu: Cpu; t: number; hammerkit: boolean }) {
  const clip = useId();
  const { width, height, top, max } = chart;
  const x = (at: number) => ((at - cpu.from) / (cpu.to - cpu.from)) * width;
  const y = (level: number) => height - (level / max) * (height - top);
  const ramp = 0.06;
  const points: [number, number][] = [[cpu.from, cpu.idle]];
  for (const burst of cpu.bursts) {
    points.push(
      [burst.at, cpu.idle],
      [burst.at + ramp, burst.level],
      [end(burst) - ramp, burst.level],
      [end(burst), cpu.idle]
    );
  }
  points.push([cpu.to, cpu.idle]);
  const line = points.map(([at, level], i) => `${i ? 'L' : 'M'} ${x(at)} ${y(level)}`).join(' ');
  const area = `${line} L ${x(cpu.to)} ${height} L ${x(cpu.from)} ${height} Z`;
  const shown = clamp((t - cpu.from) / (cpu.to - cpu.from));
  const used = hammerkit ? 'emerald' : 'sky';
  const px = 96; // the chart's height in CSS pixels (h-24), to place labels over it

  return (
    <div className="mt-3">
      <div className="relative h-24">
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-full w-full overflow-visible">
          <defs>
            <clipPath id={clip}>
              <rect x={0} y={-10} width={width * shown} height={height + 20} />
            </clipPath>
          </defs>
          <line
            x1={0}
            x2={width}
            y1={y(max)}
            y2={y(max)}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
            className="stroke-white/10"
          />
          <line
            x1={0}
            x2={width}
            y1={height}
            y2={height}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
            className="stroke-white/20"
          />
          <g clipPath={`url(#${clip})`}>
            {cpu.reserved !== undefined && (
              <>
                <rect
                  x={0}
                  y={y(cpu.reserved)}
                  width={width}
                  height={height - y(cpu.reserved)}
                  className="fill-amber-300/10"
                />
                <line
                  x1={0}
                  x2={width}
                  y1={y(cpu.reserved)}
                  y2={y(cpu.reserved)}
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                  className="stroke-amber-300/80"
                />
              </>
            )}
            <path d={area} className={used === 'emerald' ? 'fill-emerald-400/15' : 'fill-sky-400/10'} />
            <path
              d={line}
              fill="none"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              className={used === 'emerald' ? 'stroke-emerald-400' : 'stroke-sky-400'}
            />
          </g>
          {shown > 0 && shown < 1 && (
            <line
              x1={width * shown}
              x2={width * shown}
              y1={top - 6}
              y2={height}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              className="stroke-white/30"
            />
          )}
        </svg>
        <span
          className="absolute left-0 text-[9px] leading-none text-white/35"
          style={{ top: (y(max) / height) * px - 11 }}
        >
          {max} vCPU
        </span>
        {cpu.bursts.map((burst) =>
          t >= burst.at ? (
            <span
              key={burst.label}
              className="absolute -translate-x-1/2 text-[9px] leading-none text-white/60"
              style={{
                left: `${(x(burst.at + burst.dur / 2) / width) * 100}%`,
                top: (y(burst.level) / height) * px - 12,
              }}
            >
              {burst.label}
            </span>
          ) : null
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-white/50">
        {cpu.reserved !== undefined && (
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-3 border-t-2 border-amber-300/80 bg-amber-300/10" />
            reserved, billed
          </span>
        )}
        <span className="flex items-center gap-1.5">
          <span className={`h-0.5 w-3 rounded-full ${used === 'emerald' ? 'bg-emerald-400' : 'bg-sky-400'}`} />
          {cpu.reserved !== undefined ? 'used' : 'used, billed'}
        </span>
      </div>
    </div>
  );
}

function Column({
  panel,
  index,
  scene,
  t,
  hubRow,
}: {
  panel: Panel;
  index: number;
  scene: Scene;
  t: number;
  hubRow: boolean; // some column has a hub: side by side, keep its row in every column so the lanes line up
}) {
  const hammerkit = index > 0;
  const finished = t >= panelEnd(panel);
  const hub = panel.hub ? hubs[panel.hub] : undefined;
  const { active, used } = hubAt(panel, t);
  const root = useRef<HTMLDivElement>(null);
  const lines = useSecretLines(root, panel);

  return (
    <div
      ref={root}
      className="relative isolate flex min-w-0 flex-col py-5 first:pt-0 last:pb-0 sm:px-4 sm:py-0 sm:first:pl-0 sm:last:pr-0"
    >
      {panel.secrets && <SecretLines panel={panel} lines={lines} t={t} />}
      <div className={`font-sans text-xs font-semibold ${hammerkit ? 'text-emerald-300' : 'text-white/50'}`}>
        {titleOf(panel, index)}
      </div>
      {scene.totals && (
        <div className="mt-1 leading-snug tabular-nums text-white/45">
          time {minutes(waited(panel, t))}
          {scene.totals !== 'time' && (
            <>
              <br />
              compute {minutes(elapsed(metered(panel.lanes.flatMap(spansOf)), t))}
            </>
          )}
        </div>
      )}
      {hubRow && (
        <div
          className={`mt-2 h-4 items-center gap-1 text-[10px] transition-colors duration-300 ${
            hub ? 'flex' : 'hidden sm:flex'
          } ${active ? 'text-emerald-200' : used ? 'text-emerald-300/80' : 'text-white/35'}`}
        >
          {hub && (
            <>
              <hub.icon className="size-3" />
              {hub.name}
            </>
          )}
        </div>
      )}
      {panel.cpu ? (
        <CpuChart cpu={panel.cpu} t={t} hammerkit={hammerkit} />
      ) : panel.secrets ? (
        <div className="mt-3 flex gap-5">
          <div className="min-w-0 flex-1 space-y-3">
            {panel.lanes.map((lane, i) => (
              <LaneView key={i} lane={lane} index={i} t={t} timer={!!scene.laneTimers} />
            ))}
          </div>
          <SecretVault secrets={panel.secrets} />
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {panel.lanes.map((lane, i) => (
            <LaneView key={i} lane={lane} index={i} t={t} timer={!!scene.laneTimers} />
          ))}
        </div>
      )}
      <p
        className={`mt-auto pt-4 font-sans text-[13px] transition-opacity duration-500 ${
          finished ? 'opacity-100' : 'opacity-0'
        } ${hammerkit ? 'text-emerald-300' : 'text-white/60'}`}
      >
        {panel.caption}
      </p>
    </div>
  );
}

const columns: Record<number, string> = { 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3' };

// Plays a scene once when its element scrolls into view, and stays on the last frame.
function usePlayback(scene: Scene) {
  const ref = useRef<HTMLDivElement>(null);
  const [run, setRun] = useState(0); // 0 until it first scrolls into view
  const [t, setT] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);

  // a little past the last step, so rounding can't leave it a hair short of done
  const last = sceneEnd(scene) + 0.05;
  const time = reducedMotion ? last : t;

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setRun((r) => r || 1);
        observer.disconnect();
      },
      { threshold: 0.4 }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (reducedMotion || run === 0) return;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const played = (now - start) / 1000 / pace;
      setT(Math.min(played, last));
      if (played < last) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [run, last, reducedMotion]);

  const replay = () => {
    setT(0);
    setRun((r) => r + 1);
  };

  return { ref, time, finished: time >= last, replay, reducedMotion };
}

export function BeforeAfter({ scene: key }: { scene: FeatureKey }) {
  const scene = scenes[key];
  const { ref, time, finished, replay, reducedMotion } = usePlayback(scene);
  const panels = panelsOf(scene);
  const hubRow = panels.some((panel) => panel.hub);

  return (
    <div ref={ref} className="min-w-0 rounded-2xl bg-zinc-950 p-5 text-left font-mono text-[11px] text-white shadow-xl">
      <div className="mb-5 flex items-center justify-between gap-2 text-white/40">
        <p aria-hidden>› {scene.note}</p>
        {!reducedMotion && (
          <button
            onClick={replay}
            className={`flex shrink-0 items-center gap-1 font-sans text-xs transition hover:text-white/80 ${
              finished ? 'opacity-100' : 'pointer-events-none opacity-0'
            }`}
          >
            <RotateCcw className="size-3" /> Replay
          </button>
        )}
      </div>
      <p className="sr-only">{panels.map((panel, i) => `${titleOf(panel, i)}: ${panel.caption}`).join(' ')}</p>
      <div
        aria-hidden
        className={`grid divide-y divide-white/10 sm:divide-x sm:divide-y-0 ${scene.split ?? columns[panels.length]}`}
      >
        {panels.map((panel, i) => (
          <Column key={i} panel={panel} index={i} scene={scene} t={time} hubRow={hubRow} />
        ))}
      </div>
    </div>
  );
}
