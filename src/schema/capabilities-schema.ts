import { array, enum as zenum } from 'zod'

// The Linux capabilities, without the CAP_ prefix (capabilities(7))
export const LINUX_CAPABILITIES = [
  'AUDIT_CONTROL',
  'AUDIT_READ',
  'AUDIT_WRITE',
  'BLOCK_SUSPEND',
  'BPF',
  'CHECKPOINT_RESTORE',
  'CHOWN',
  'DAC_OVERRIDE',
  'DAC_READ_SEARCH',
  'FOWNER',
  'FSETID',
  'IPC_LOCK',
  'IPC_OWNER',
  'KILL',
  'LEASE',
  'LINUX_IMMUTABLE',
  'MAC_ADMIN',
  'MAC_OVERRIDE',
  'MKNOD',
  'NET_ADMIN',
  'NET_BIND_SERVICE',
  'NET_BROADCAST',
  'NET_RAW',
  'PERFMON',
  'SETFCAP',
  'SETGID',
  'SETPCAP',
  'SETUID',
  'SYS_ADMIN',
  'SYS_BOOT',
  'SYS_CHROOT',
  'SYS_MODULE',
  'SYS_NICE',
  'SYS_PACCT',
  'SYS_PTRACE',
  'SYS_RAWIO',
  'SYS_RESOURCE',
  'SYS_TIME',
  'SYS_TTY_CONFIG',
  'SYSLOG',
  'WAKE_ALARM',
] as const

export type LinuxCapability = (typeof LINUX_CAPABILITIES)[number]

// Capabilities a container gets on top of its runtime's default set, by name such as
// SYS_ADMIN. `ALL` is not one: a task names what it needs.
export const capabilitiesSchema = array(
  zenum(LINUX_CAPABILITIES, {
    errorMap: (issue, ctx) =>
      issue.code === 'invalid_enum_value'
        ? { message: `unknown capability ${JSON.stringify(issue.received)}, expected a name such as SYS_ADMIN` }
        : { message: ctx.defaultError },
  })
).refine((names) => new Set(names).size === names.length, 'a capability is listed twice')
