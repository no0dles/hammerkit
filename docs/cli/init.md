---
description: Create a starter build file in the current directory.
---

# Init

`init` is available only when no build file exists yet. It writes a minimal
`.hammerkit.yaml` with a single `example` task so you have something to run
immediately.

### Command

{% tabs %}
{% tab title="Shell" %}
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

### Console output

```
created .hammerkit.yaml
```

### Result

{% code title=".hammerkit.yaml" %}
```yaml
envs: {}

tasks:
  example:
    image: alpine
    cmds:
      - echo "it's Hammer Time!"
```
{% endcode %}

Run it with `hammerkit example` (the task is called `example`, not `build`).

{% hint style="info" %}
Hammerkit keeps its local cache state in a `.hammerkit` directory. Add it to your
`.gitignore` so it is not committed:

```
.hammerkit
```
{% endhint %}
