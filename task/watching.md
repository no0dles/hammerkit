---
description: >-
  For tasks which source files change frequently and require to redo the work on
  a watch.
---

# Watching

Task with source folders and files can be watched and on changed get restarted. This can be used for example to run api servers and restarted if the server code changes.

{% code title="build.yaml" %}
```yaml
tasks:
  api:
    src:
      - src
    cmds:
      - node -r ts-node/register src/index.ts
```
{% endcode %}

{% tabs %}
{% tab title="shell" %}
```bash
hammerkit api --watch
```
{% endtab %}
{% endtabs %}

