---
description: Short introduction to get started with your first build file
---

# Getting started

## Create your first build file

To get started with hammerkit, you will need to create your first build file. Build files are usually called `.hammerkit.yaml` and can be created from scratch manually or by using the init command.&#x20;

{% tabs %}
{% tab title="shell" %}
```bash
hammerkit init
```
{% endtab %}
{% endtabs %}

If you created your build file with the init command, the build file will look like the example below.

{% code title=".hammerkit.yaml" %}
```yaml
envs: {}

tasks:
  example:
    image: alpine
    cmds:
      - echo it's Hammer Time!
```
{% endcode %}

This build file contains an example command which prints a statement to the console inside an alpine container.&#x20;

{% hint style="warning" %}
This requires to have a running docker deamon, if that's not the case, remove line 5 with the image property.
{% endhint %}

## Run your first task

To run your first command, make sure your in the same directory as the build file is and run:

{% tabs %}
{% tab title="shell" %}
```bash
hammerkit example
```
{% endtab %}
{% endtabs %}

This executes the echo command `it's Hammer Time!` and exits with code 0.&#x20;

## Conclusion

In this short introduction you created your first build file and executed your first task. The build file and the task in this example were very basic, to see the full functionality of hammerkit, take a look at the rest of the documentation.
