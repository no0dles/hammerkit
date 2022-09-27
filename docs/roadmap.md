# Roadmap
The following topics are planned to be addressed in the future.

## Services
Task sometimes require some service to run.
For example a database, which is required to run an api or an integration test.
The goal will be to define those and hammerkit spins them up for the task and shuts them down if not needed.

## Distributed caching
Distribute local cache, so other developers and the CI can use already build up caches.
The goal will be general performance improvements on CI and local development.

## Distributed computing
Offload complex and compute intense tasks to remote hardware.
The goal will be use the power of cloud computing, with very less configuration.

## Platform requirements
Define tasks that require a specific platform for local tasks.
The goal will be to either skip local tasks where platform requirements are not met or execute them on a remote machine.

