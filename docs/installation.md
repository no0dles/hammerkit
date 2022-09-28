# Installation

The different ways to install and use hammerkit

## Npm / Yarn

Hammerkit can be easily installed and upgraded by npm/yarn. 
If node is already installed.

{% tabs %}
{% tab title="npm" %}
```bash
npm i -g hammerkit
```
{% endtab %}

{% tab title="yarn" %}
```bash
yarn add -g hammerkit
```
{% endtab %}
{% endtabs %}

## Homebrew

With homebrew hammerkit can be installed on mac and linux (including windows with WSL).

```
brew tap no0dles/hammerkit
brew install hammerkit
```

## Binary

Each release of hammerkit has a [release](https://github.com/no0dles/hammerkit/releases) on github with binaries for windows, macos and linux. 
Those do not require to have node installed and support `arm` and `x86`.

## Docker

The docker image on [docker hub](https://hub.docker.com/r/no0dles/hammerkit) contains hammerkit and can be used for dind. 
For container builds on CI systems its the recommended approach.

## Gitlab CI

{% code title=".gitlab-ci.yml" %}
```yaml
variables:
  DOCKER_DRIVER: overlay2

services:
  - docker:19.03.0-dind

build:
  image: no0dles/hammerkit
  script:
    - hammerkit build
```
{% endcode %}

## Github Action

For github action there is the `no0dles/hammerkit-github-action` action to install hammerkit. 
The action requires the `setup-node` to run correctly.

```yaml
jobs:
  build:
    runs-on: ubuntu-18.04
    steps:
      - name: Checkout
        uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: '16'
      - uses: no0dles/hammerkit-github-action@v1.3
```
