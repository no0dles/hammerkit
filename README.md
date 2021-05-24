---
description: Short introduction to get started with your first build file
---

# Getting started

## Installation / Upgrade

Hammerkit can be easily installed and upgraded by npm/yarn.

{% tabs %}
{% tab title="npm" %}
```text
npm i -g hammerkit
```
{% endtab %}

{% tab title="yarn" %}
```text
yarn add -g hammerkit
```
{% endtab %}
{% endtabs %}



## Create your first build file

To get started with hammerkit, you will need to create your first build file. Build files are usually called `build.yaml` and can be created from scratch manually or by using the init command. 

{% tabs %}
{% tab title="shell" %}
```text
hammerkit init
```
{% endtab %}
{% endtabs %}

If you created your build file with the init command, the build file will look like the example below.

{% code title="build.yaml" %}
```text
envs: {}

tasks:
  example:
    image: alpine
    cmds:
      - echo "it's Hammer Time!"
```
{% endcode %}

This build file contains an example command which prints a statement to the console inside an alpine docker container. 

{% hint style="warning" %}
This requires to have a running docker deamon, if that's not the case, remove line 5 with the image property.
{% endhint %}

## Run your first task

To run your first command, make sure your in the same directory as the build file is and run:

{% tabs %}
{% tab title="shell" %}
```text
hammerkit example
```
{% endtab %}
{% endtabs %}





