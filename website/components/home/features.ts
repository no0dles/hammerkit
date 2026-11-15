import { Bot, Box, Container, DatabaseZap, Eye, KeyRound, Network, Server, Timer } from 'lucide-react';

// The points of the landing page, one section each with its before/after
// illustration and the docs pages that explain it. `experimental` marks what the
// docs still call experimental.
export const features = [
  {
    key: 'containers',
    icon: Container,
    experimental: false,
    title: 'Same tools everywhere',
    text: 'Each task runs in a container from the image it names, so your dev machine and CI use the exact same tool versions.',
    links: [
      { label: 'Tasks in containers', href: '/docs/task/container' },
      { label: 'Local or container?', href: '/docs/guides/local-vs-container' },
    ],
  },
  {
    key: 'cache',
    icon: DatabaseZap,
    experimental: false,
    title: 'Skips what didn’t change',
    text: 'Results go to a distributed task cache. When a task’s inputs haven’t changed, hammerkit restores its outputs instead of running it again.',
    links: [
      { label: 'How caching works', href: '/docs/task/caching' },
      { label: 'Cache backends', href: '/docs/build-file/caches' },
    ],
  },
  {
    key: 'ci',
    icon: Timer,
    experimental: false,
    title: 'Save CI minutes',
    text: 'CI is there to confirm the work was done, not to redo it. Tasks that already ran on a dev machine or in an agent sandbox come from the cache, so CI runs only what’s new.',
    links: [
      { label: 'Caching in CI', href: '/docs/guides/ci-caching' },
      { label: 'Verify checks in CI', href: '/docs/guides/agents/verified-checks' },
    ],
  },
  {
    key: 'agents',
    icon: Bot,
    experimental: false,
    title: 'Scale with agents',
    text: 'When agents write the code, builds become the bottleneck. Every sandbox reuses what’s already built, so more agents don’t mean more wasted compute.',
    links: [
      { label: 'Agents, workspaces and CI', href: '/docs/guides/agents-and-ci' },
      { label: 'Agents on a server', href: '/docs/guides/agents' },
    ],
  },
  {
    key: 'secrets',
    icon: KeyRound,
    experimental: false,
    title: 'Secrets only where they’re used',
    text: 'A task names the secrets it needs, and only that task gets them. Values never land in the build file, the cache or the logs.',
    links: [
      { label: 'Secrets', href: '/docs/task/secrets' },
      { label: 'Secret providers', href: '/docs/task/secret-providers' },
      { label: 'Who gets which secrets', href: '/docs/remote-compute/accounts' },
    ],
  },
  {
    key: 'network',
    icon: Network,
    experimental: false,
    title: 'Network limits per task',
    text: 'Each task reaches only what it needs: nothing for the tests, the package registry for an install, the host it deploys to for a deploy.',
    links: [{ label: 'Network', href: '/docs/task/network' }],
  },
  {
    key: 'remote',
    icon: Server,
    experimental: true,
    title: 'Remote compute',
    text: 'Work on several worktrees at once without your dev machine as the limit: their tasks run on a hammerkit server, side by side, with the hardware and credentials the work needs.',
    links: [
      { label: 'Remote compute', href: '/docs/remote-compute' },
      { label: 'Runs', href: '/docs/remote-compute/runs' },
    ],
  },
  {
    key: 'sandbox',
    icon: Box,
    experimental: true,
    title: 'Sandboxes for agents',
    text: 'An agent’s checkout stays on the server and gets compute only while one of its tasks runs. While the agent thinks, a sandbox costs its storage and nothing else.',
    links: [
      { label: 'Sandboxes', href: '/docs/remote-compute/sandboxes' },
      { label: 'Agents on a server', href: '/docs/remote-compute/agents' },
    ],
  },
  {
    key: 'preview',
    icon: Eye,
    experimental: true,
    title: 'Previews of every branch',
    text: 'Bring up every worktree or branch on the server at once, each at a URL of its own behind your sign-in. Previews sleep while nobody looks and end on their own.',
    links: [
      { label: 'Service runs', href: '/docs/remote-compute/service-runs' },
      { label: 'remote up', href: '/docs/cli/remote' },
    ],
  },
] as const;

export type FeatureKey = (typeof features)[number]['key'];
