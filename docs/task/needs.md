---
description: >-
A task can declare needs on services. Hammerkit awaits the start of tasks until all service needs are ready.
---

# Needs
Needs can be used to connect services with tasks.
Hammerkit will start services depending on the needs of tasks.

Healtchecks will ensure, that the service is ready, before the task gets started.

```yaml
services:
  postgres:
    image: postgres:12-alpine
    healthcheck:
      cmd: "pg_isready -U postgres"
    
tasks:
  install:
    description: "start api"
    needs: [postgres]
    cmds:
      - node index.js
```
