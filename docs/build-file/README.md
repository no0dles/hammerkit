---
description: A summary of all build file configuration options
---

# Build file

The build file is a yaml file in the root of your project. It contains a list of [tasks](../task/README.md) which can be executed over the [cli](../cli/README.md).&#x20;

Hammerkit looks for the build file by name, in this order:

1. `.hammerkit.yaml`
2. `.hammerkit.yml`
3. `build.yaml`

All three are valid; the first one found is used. If more than one exists hammerkit warns about the ambiguity. These docs use `.hammerkit.yaml` as the canonical name in every example. To point hammerkit at a different file, pass [`--file <path>`](../cli/README.md).

{% code title=".hammerkit.yaml" %}
```yaml
envs:
  NODE_VERSION: '22'

tasks:
  build:
    image: node:$NODE_VERSION
    deps: [npm:install]
    cmds:
      - tsc -b

references:
  subProject: ./packages/subproject

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

