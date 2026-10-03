import { describeTutorial } from '../tutorial-test'

describeTutorial('tutorial-rust', ['.hammerkit.yaml', 'Cargo.toml', 'Cargo.lock', 'src'], 'bin/greet')
