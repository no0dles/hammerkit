---
description: >-
  References allow the usage of tasks defined in other build files. They
  can be used to split up tasks into separate files.
---

# References

Each build file can have a `references` map pointing at other build files. The
referenced file brings in more tasks and services, which you can then use directly
from the [cli](../cli/README.md) or as [task dependencies](../task/dependencies.md).

{% code title=".hammerkit.yaml" %}
```yaml
references:
  foo: project/foo
```
{% endcode %}

{% code title="project/foo/.hammerkit.yaml" %}
```yaml
tasks:
  example:
    cmds:
      - echo "foo bar"
```
{% endcode %}

## Naming and prefixes

A referenced task is addressed as `<prefix>:<taskName>`, where the prefix is the
key you gave it in the `references` map. The `example` task above becomes
`foo:example`:

{% tabs %}
{% tab title="shell" %}
```bash
hammerkit foo:example
```
{% endtab %}
{% endtabs %}

The same `prefix:name` syntax is what you use in `deps` and `needs`:

{% code title=".hammerkit.yaml" %}
```yaml
references:
  foo: project/foo

tasks:
  build:
    deps: [foo:example]
    cmds:
      - echo "after foo"
```
{% endcode %}

References can be nested — a referenced file can have its own references — and the
prefixes stack (`foo:bar:task`). This same prefix rule is shared with
[includes](includes.md) and [extend](../task/extending.md).

## References keep their own working directory

The key difference from [includes](includes.md): a referenced task runs with **its
own** directory as the working directory. Commands and relative `src`/`generates`
paths resolve against the referenced file's location, not yours. Use a reference
when the other file is a real project in its own right; use an include when you
want to *reuse a task definition* in the current project's directory.

{% hint style="warning" %}
Build-file `envs` do **not** cross a reference. Variables declared at the top level
of one file are not visible to a referenced (or [included](includes.md)) file —
each file's `envs` are scoped to that file. Declare the variables a referenced task
needs in that file (or on the task itself).
{% endhint %}
