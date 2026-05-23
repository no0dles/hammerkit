# Changelog 1.4.0

A detailed summary about the release and reason behind the made changes can be found [here](https://app.gitbook.com/@no0dles/s/hammerkit/release-blog/release-1.4.0).

## Added
- Added a missing license file to the repo (MIT)
- Added a best-practices folder to the repo with examples how to use hammerkit
- Added a port list for docker tasks to map container ports to the local machine
- Added a Linux and macOS test runner to the CI

## Changed
- 3 new logging modes (interactive, live, grouped). Interactive is the default mode expect for non CI environments which use live.
- The watch flag gets removed from the task definition in favor of the new --watch argument. This allows hammerkit to watch the entire dependency chain and restart depending on tasks.   
- Move the local cache dir `.hammerkit` into the user directory. Removing the need to exclude it from the source code or builds.
- Docker tasks use volumes instead of mounts for generated files. Increasing stability and performance hugely. Reducing conflict with local development environment and the --no-container flag.
- The source code got updated to node version 16, since it will be soon the next LTS. The upgrade was needed to take advantage of the new AbortController. Hammerkit requires at least node version 15.
- Replaced all usage of the defer class with the AbortController, which caused issues with unhandled promises on newer node versions.
- Store and restore format has changed for docker tasks, because of the changes to generated files and the usage of volumes.

## Fixed
- Docker tasks on windows sometimes got stuck, because the docker daemon did not close the stream. The status of the container gets now regularly polled, to handle this exception. 
