// The variables of the test machine that a server in a test lets its runs see:
// the tools git, the shell and docker need to be found, as an operator would list
// them in `runs.env.allow`.
export const HOST_ENV_ALLOW = [
  'PATH',
  'HOME',
  'LANG',
  'TMPDIR',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  // Windows: without these powershell and git can not find their profile
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  // powershell is very slow to start without it
  'PSModulePath',
]

// The `runs` of a test server's config: tasks find their tools.
export const HOST_ENV_YAML = `runs: { env: { allow: ${JSON.stringify(HOST_ENV_ALLOW)} } }\n`

// And the `runtimes`: local tasks (a command without an image) are allowed, as an
// operator who wants them says so.
export const HOST_RUNS_YAML = `${HOST_ENV_YAML}runtimes: [docker, local]\n`
