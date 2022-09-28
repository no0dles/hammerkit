---
description: >-
  A task can require dependant tasks that will get executed first (if not
  cached).
---

# Dependencies

Every task can have list of dependencies. Those will be executed before and if any of them fails abort the all pending tasks. Dependencies can be chained as deep as needed, as long as there is no loop.&#x20;

{% code title="build.yaml" %}
```yaml
tasks:
  install:
    cmds:
      - npm install
      
  build:
    deps: [install]
    cmds:
      - tsc -b
  
  publish:
    deps: [build]
    cmds:
      - npm publish
```
{% endcode %}

{% hint style="info" %}
Make sure to setup correct [caching](caching.md) to speed up your execution and prevent unnecessary work.
{% endhint %}
