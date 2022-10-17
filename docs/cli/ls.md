---
description: Inspect configured tasks that are available to you
---

# ls

Print information about tasks and services. 

```
Services:
• postgres
   ports: 127.0.0.1:5432 -> 5432
   image: postgres:12

Tasks:
• install
   image: node:16.6.0-alpine
   labels: stage=build
   src: package.json package-lock.json
   generates: node_modules
• api
   needs: postgres
   deps: install
   image: node:16.6.0-alpine
   labels: stage=run app=example
   src: index.js config.json package.json package-lock.json
   generates: node_modules
```

