export interface WorkNodeSource {
  absolutePath: string
  matcher: (fileName: string, cwd: string) => boolean
}
