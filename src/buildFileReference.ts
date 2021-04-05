import {ParsedBuildFile} from './parsedBuildFile';

export interface BuildFileReference {
  buildFile: ParsedBuildFile
  type: 'include' | 'reference'
  name: string
}
