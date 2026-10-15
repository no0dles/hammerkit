// The hammerkit plugin for opencode, re-exported by a plugin file of the project:
// `export { HammerkitPlugin } from 'hammerkit/harness/opencode'`, see
// https://hammerkit.dev/docs/remote-compute/agents
import { loadHammerkitOpencodePlugin } from '../dist/harness/opencode'

export const HammerkitPlugin = loadHammerkitOpencodePlugin((specifier) => import(specifier))
