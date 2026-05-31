# About

<figure><img src="docs/hammerkit-small.png" width="144" alt=""><figcaption></figcaption></figure>

## What is hammerkit?

Hammerkit is a build tool intended to build software projects in **containers** locally and in a CI. The advantages of containerized builds are:

* the build tools come from the container image, so they are the same across all machines.
* the build process is isolated since every file in the container has to be declared as a source or an output. Therefore, side effects can be reduced.

For a fuller pitch — including how it compares to Make, npm scripts, Taskfile and Earthly — see [Why hammerkit](docs/why-hammerkit.md).

There are a lot of containerized CI systems that allow writing containerized builds today, but they lack some features hammerkit tries to solve:

* they are often not **usable during development** on your local machine, so you either have to maintain two build scripts or wrap one of them in the other.
* they mount the entire repository into the container, so uncontrolled **side effects** can reduce reliability.
* some of them do not allow **switching images** between build steps, requiring you to maintain one large build image that contains every tool needed to build the software.

Additionally, hammerkit tries to reduce complexity of build caching in CI systems. Usually you define a directory that is being cached and restored before and after the CI build. That's totally fine for smaller project where there are not that many directories to cache. The bigger the project gets, the more effort it is, to keep all directories up to date.

Hammerkit on the other hand knows the source and output files of each build step and can therefore compact the build results into a single directory. Making it easy to being cached. Once restored, hammerkit can detect what's changed since last time and only build the changes.

## Where to go next?

Check out the [docs](https://no0dles.gitbook.io/hammerkit/) for more info about how hammerkit can be used.
