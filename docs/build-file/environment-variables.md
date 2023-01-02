---
description: >-
  Environment variables can be used from three different sources. Shell
  environment, .env files or predefined values inside the build file.
---

# Environment Variables

## Shell environment

Environment variables which are available from the shell environment get passed into the command before execution.

{% code title=".hammerkit.yaml" %}
```yaml
tasks:
  example:
    envs:
      VERSION: $VERSION
    cmds:
      - echo $VERSION
```
{% endcode %}

{% hint style="info" %}
Each environment variable that is used, should be specified in the `envs` of the task. Hammerkit ensures that the environment variable is defined, otherwise will throw an error to prevent undesired behavior.
{% endhint %}

## .env file

Environment variables can be defined in the .env file. Those are recommended for secret values that should not be committed nor public.

{% code title=".env" %}
```
NPM_TOKEN=abc
```
{% endcode %}

{% code title=".hammerkit.yaml" %}
```yaml
tasks:
  example:
    envs:
      NPM_TOKEN: $NPM_TOKEN
    cmds:
      - npm publish
```
{% endcode %}

## Defined values in the build file

Environment variables can be defined in the build file itself. They are can be defined for the entire build file or only for specific tasks.

{% code title=".hammerkit.yaml" %}
```yaml
envs:
  NODE_VERSION: 14.16.0
  
tasks:
  example:
    cmds:
      - echo $NODE_VERSION
      
  override_example:
    envs:
      NODE_VERSION: 14.0.0
    cmds:
      - echo $NODE_VERSION
```
{% endcode %}

{% hint style="warning" %}
The scope of the defined environment variables are fixed to the build file they are defined in. Neither [referenced](references.md) nor [included](includes.md) tasks will have access to those.
{% endhint %}
