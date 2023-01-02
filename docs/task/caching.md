---
description: >-
  A task can be skipped if nothing regarding the input source files has changed.
  This saves a lot of time and resources.
---

# Caching

Every task should define source files it requires. Based on those files, hammerkit can check if since the last run, something has changed that requires to rerun the commands of the task. If all source files are unchanged since the last run, the entire task gets skipped.

{% hint style="warning" %}
If a dependency task has changed or has no source files defined, the task gets executed every run. The task can only get skipped, if all dependencies before can be skipped as well, otherwise the result could be inconsistent.
{% endhint %}

### Define source files

The following example defines the `package.json` and `package-lock.json` as a source file. Before each run the checksum of those two files are compared with the checksum of the last successful run and if equal the task will get skipped.

{% code title=".hammerkit.yaml" %}
```yaml
tasks:
  install:
    src:
      - package.json
      - package-lock.json
    cmds:
      - npm install
```
{% endcode %}

### Define source folders

The next example defines the `src` folder as the task source. The check if the task can be skipped, the entire folder will be recursively traversed.

{% code title=".hammerkit.yaml" %}
```yaml
tasks:
  build:
    src:
      - src
    cmds:
      - tsc -b
```
{% endcode %}

{% hint style="warning" %}
Keep in mind that the recursive traverse can be quite expensive on huge folders. It's not recommended to use for example a `node_modules` folder as a source folder.
{% endhint %}

### Define glob sources

This example defines a glob pattern `src/**/*.ts` as the task source. This is similar to the folder source, but filters for example the extension type.

{% code title=".hammerkit.yaml" %}
```yaml
tasks:
  build:
    src:
      - src/**/*.ts
    cmds:
      - tsc -b
```
{% endcode %}

There are multiple patterns supported. Hammerkit uses the node-glob package. For all details checkout the docs [here](https://github.com/isaacs/node-glob) or take a look at a quick summary here:

* `*` Matches 0 or more characters in a single path portion
* `?` Matches 1 character
* `[...]` Matches a range of characters, similar to a RegExp range. If the first character of the range is `!` or `^` then it matches any character not in the range.
* `!(pattern|pattern|pattern)` Matches anything that does not match any of the patterns provided.
* `?(pattern|pattern|pattern)` Matches zero or one occurrence of the patterns provided.
* `+(pattern|pattern|pattern)` Matches one or more occurrences of the patterns provided.
* `*(a|b|c)` Matches zero or more occurrences of the patterns provided
* `@(pattern|pat*|pat?erN)` Matches exactly one of the patterns provided
* `**` If a "globstar" is alone in a path portion, then it matches zero or more directories and subdirectories searching for matches. It does not crawl symlinked directories.
