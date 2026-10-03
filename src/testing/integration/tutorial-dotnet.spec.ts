import { describeTutorial } from '../tutorial-test'

describeTutorial('tutorial-dotnet', ['.hammerkit.yaml', 'Directory.Build.props', 'src', 'tests'], 'out/Greet.dll')
