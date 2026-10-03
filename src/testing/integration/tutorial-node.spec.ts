import { describeTutorial } from '../tutorial-test'

describeTutorial(
  'tutorial-node',
  ['.hammerkit.yaml', 'package.json', 'package-lock.json', 'tsconfig.json', 'src', 'test'],
  'dist/greet.js'
)
