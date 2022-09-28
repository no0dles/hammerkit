---
description: A summary of all build file configuration options
---

# Build file

The build file is a yaml file with the filename `build.yaml` inside your project directory. It contains a list of [tasks](../task/) which can be executed over the [cli](../cli/).&#x20;

{% code title="build.yaml" %}
```yaml
envs:
  NODE_VERSION: 14.16.0

tasks:
  build:
    image: node:$NODE_VERSION
    deps: [npm:install]
    cmds:
      - tsc -b

references:
  subProject: ./packages/subproject/build.yaml

includes:
  npm: ./build.npm.yaml
```
{% endcode %}

For more detail about the structure of the build file, checkout the following sections.

{% content-ref url="environment-variables.md" %}
[environment-variables.md](environment-variables.md)
{% endcontent-ref %}

{% content-ref url="references.md" %}
[references.md](references.md)
{% endcontent-ref %}

{% content-ref url="includes.md" %}
[includes.md](includes.md)
{% endcontent-ref %}

