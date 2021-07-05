export interface BuildFileTaskPlatform {
  os: 'win' | 'macos' | 'linux' | null
  arch: 'arm64' | 'arm' | null
}
