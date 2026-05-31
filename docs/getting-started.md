---
description: Short introduction to get started with your first build file
---

# Getting started

## Prerequisites

Hammerkit itself only needs [Node.js](https://nodejs.org) (see [installation](installation.md)
for binary and Homebrew options that don't).

Tasks that declare an `image` run **inside a container**, so you also need a
running container engine — [Docker](https://docs.docker.com/get-docker/) or any
Docker-compatible daemon. Containers are the recommended way to run tasks: the
build then uses the exact same tools on every machine and in CI, instead of
whatever happens to be installed locally. Check the daemon is up with:

```bash
docker info
```

If that prints server information you're ready. If it errors, start Docker (or
remove the `image:` line from the example below to run on your host instead).

## Create your first build file

To get started with hammerkit, you will need to create your first build file. Build files are usually called `.hammerkit.yaml` and can be created from scratch manually or by using the init command.&#x20;

{% tabs %}
{% tab title="shell" %}
```bash
hammerkit init
```
{% endtab %}

{% tab title="npx" %}
```bash
npx hammerkit init
```
{% endtab %}
{% endtabs %}

If you created your build file with the init command, the build file will look like the example below.

{% code title=".hammerkit.yaml" %}
```yaml
envs: {}

tasks:
  example:
    image: alpine
    cmds:
      - echo it's Hammer Time!
```
{% endcode %}

This build file contains an example command which prints a statement to the console inside an alpine container.&#x20;

{% hint style="info" %}
The `image: alpine` line is what makes this task run in a container. Remove that
line and the task runs directly on your host instead — no Docker required. See
[run a task in a container](task/container.md) for the full rule.
{% endhint %}

## Run your first task

To run your first command, make sure you're in the same directory as the build file and run:

{% tabs %}
{% tab title="shell" %}
```bash
hammerkit example
```
{% endtab %}

{% tab title="npx" %}
```bash
npx hammerkit example
```
{% endtab %}
{% endtabs %}

The first run pulls the `alpine` image if it isn't on your machine yet (later runs
reuse it), starts a container, executes the echo command `it's Hammer Time!` and
exits with code `0`. Run it a second time without changing anything and hammerkit
reports the task as cached and skips it — that's [caching](task/caching.md) at work.

## Discover the tasks in a project

When you clone a repository that already uses hammerkit, list everything it
defines with:

```bash
hammerkit ls
```

This prints every task and service with its image, sources, generated outputs and
dependencies. For the full command list and global flags use:

```bash
hammerkit --help
```

## Where to go next

* [Why hammerkit](why-hammerkit.md) — what it does that Make / npm scripts / Taskfile don't.
* [Concepts](concepts.md) — local vs. container, `src`/`generates`/`mounts`, `deps` vs. `needs`.
* [Tutorial](tutorial.md) — build, test and cache a real Node project end to end.
* [Task](task/README.md) — sources, outputs, dependencies and caching in depth.
* The runnable [`examples/`](https://github.com/no0dles/hammerkit/tree/master/examples) folder in the repository.

## Conclusion

In this short introduction you created your first build file and executed your first task. The build file and the task in this example were very basic, to see the full functionality of hammerkit, take a look at the rest of the documentation.
