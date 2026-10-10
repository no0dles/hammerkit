import { describeTutorial } from '../tutorial-test'

describeTutorial('tutorial-java', ['.hammerkit.yaml', 'pom.xml', 'src'], 'target/greet-1.0.0.jar')
