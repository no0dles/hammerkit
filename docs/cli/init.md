---
description: >-
  Create a empty build file and adds the hammerkit cache directory to the
  .gitignore.
---

# Init

### Command

{% tabs %}
{% tab title="Shell" %}
```bash
hammerkit init
```
{% endtab %}
{% endtabs %}

### Console output

```
✔ created /home/user/build.yaml                                                                                                           12:36:50
✔ created /home/user/.gitignore with hammerkit cache directory 
```

### Result

{% code title="build.yaml" %}
```
envs: {}

tasks:
  example:
    image: alpine
    cmds:
      - echo "it's Hammer Time!"
      
```
{% endcode %}

{% code title=".gitignore" %}
```
.hammerkit
```
{% endcode %}
