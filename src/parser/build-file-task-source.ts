export interface BuildFileTaskSource {
  relativePath: string
  matcher: (fileName: string, cwd: string) => boolean
}
