# About

<figure><img src="docs/hammerkit.png" alt=""><figcaption></figcaption></figure>

## What is hammerkit?

Hammerkit is a build tool intended to build software projects in **containers** locally and in a CI. The advantage of containerized builds are:

* the build tools used from the container image are the same across all machines.
* the build process is isolated since every file in the container has to be declared as a source or an output. Therefore side effect should never occur.

There are a lot of containerized CI systems that allow writing containerized builds today, but they lack some features hammerkit tries to solve:

* they are often not **usable during development** on your local machine, so you have either maintain two build scripts or wrap one of them in the other.
* they mount the entire repository into the container and can therefore \*\*\*\* side effect \*\*\*\* can reduce reliability
* some of them do not allow **switching images** during build steps. Requiring to maintain a large build image, that contains all tools needed to build to software.

Additionally hammerkit tries to reduce complexity of build caching in CI systems. Usually you define a directory that is being cached and restored before and after the CI build. That's totally fine for smaller project where there are not that many directories to cache. The bigger the project gets, the more effort it is, to keep all directories up to date.

Hammerkit on the other hand knows the source and output files of each build step and can therefore compact the build results into a single directory. Making it easy to being cached. Once restored, hammerkit can detect what's changed since last time and only build the changes.
