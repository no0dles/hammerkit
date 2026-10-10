import { describeTutorial } from '../tutorial-test'

describeTutorial('tutorial-go', ['.hammerkit.yaml', 'go.mod', 'go.sum', 'main.go', 'greet'], 'bin/greet')
