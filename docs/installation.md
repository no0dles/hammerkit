# Installation

The different ways to install and use hammerkit.

{% hint style="info" %}
Tasks that declare an `image` run in a container, so you also need a running
container engine ([Docker](https://docs.docker.com/get-docker/) or compatible).
Check it with `docker info`. Tasks without an `image` run on the host and need only
the tools they call.
{% endhint %}

## Npm / Yarn

If Node.js is installed, hammerkit can be installed and upgraded with npm or yarn.

{% tabs %}
{% tab title="npm" %}
```bash
npm i -g hammerkit
```
{% endtab %}

{% tab title="yarn" %}
```bash
yarn global add hammerkit
```
{% endtab %}
{% endtabs %}

## Npx

If Node.js is installed, hammerkit can be run directly without a global install using `npx`.
This always uses the latest published version.

```bash
npx hammerkit init
npx hammerkit example
```

{% hint style="info" %}
`example` here is the task name that [`init`](cli/init.md) writes — it is not a
built-in command. The commands in these docs like `hammerkit build` likewise refer
to a `build` *task* you define, not a hammerkit subcommand.
{% endhint %}

## Homebrew

With Homebrew, hammerkit can be installed on macOS and Linux (and on Windows via WSL).

```
brew tap no0dles/hammerkit
brew install hammerkit
```

## Binary

Each release of hammerkit has a [release](https://github.com/no0dles/hammerkit/releases) on GitHub with binaries for Windows, macOS and Linux.
They don't require Node.js and are available for `arm` and `x86`.

## Container

The container image on [Docker Hub](https://hub.docker.com/r/no0dles/hammerkit) contains hammerkit and can be used with Docker-in-Docker (dind).
It's the recommended approach for container builds on CI systems.

## GitLab CI

{% code title=".gitlab-ci.yml" %}
```yaml
variables:
  DOCKER_DRIVER: overlay2

services:
  - docker:dind

build:
  image: no0dles/hammerkit
  script:
    - hammerkit build
```
{% endcode %}

## GitHub Action

For GitHub Actions, the `no0dles/hammerkit-github-action` action installs hammerkit.
It requires `actions/setup-node` to run first.

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - uses: no0dles/hammerkit-github-action@v1.3
```
