export interface WorkSource {
  absolutePath: string
  source: string
  matcher: (fileName: string, cwd: string) => boolean
  inherited: boolean
  isFile: boolean
}
