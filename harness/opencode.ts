// The hammerkit plugin for opencode 2, and for opencode 1 by its `server`, re-exported by a plugin
// file of the project: `export { default } from 'hammerkit/harness/opencode'`, see
// https://hammerkit.dev/docs/remote-compute/agents
import { hammerkitOpencodeEntry } from '../dist/harness/opencode'

const plugin = hammerkitOpencodeEntry((specifier) => import(specifier))

export default plugin

// the name plugin files of opencode 1 re-exported, the same plugin so opencode 1 loads it once
export const HammerkitPlugin = plugin
