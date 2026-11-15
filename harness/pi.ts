// The hammerkit extension for pi: `pi install npm:hammerkit`. pi loads this file with its
// own module, whose tools hammerkit gives a sandbox as their backend, see
// https://hammerkit.dev/docs/remote-compute/agents
import * as pi from '@earendil-works/pi-coding-agent'
import { hammerkitPiExtension } from '../dist/harness/pi'

export default hammerkitPiExtension(pi)
