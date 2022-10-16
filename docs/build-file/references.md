---
description: >-
  References allow the usage of other tasks defined in other build files. They
  can be used to split up different tasks into separate files.
---

# References

Each build file can have a reference map. The reference points to other build file containing more tasks. References can be used directly from the [cli](../cli/) or in [task dependencies](../task/dependencies.md).

{% code title="build.yaml" %}
```yaml
references:
  foo: project/foo/build.yaml
```
{% endcode %}

{% code title="project/foo/build.yaml" %}
```yaml
tasks:
  example:
    cmds:
      - echo "foo bar"
```
{% endcode %}

The task name `example` in the referenced build file will be prepended with the reference name `foo` and can be used as `foo:example`&#x20;

{% tabs %}
{% tab title="shell" %}
```bash
hammerkit foo:example
```
{% endtab %}
{% endtabs %}
