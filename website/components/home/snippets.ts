// Code shown on the landing page.

export const buildFile = `tasks:
  install:
    image: node:24-alpine
    src: [package.json, package-lock.json]
    generates: [node_modules]
    cmds: [npm ci]

  test:
    image: node:24-alpine
    deps: [install]
    needs: [db]
    src: [src, test]
    cmds: [npm test]

  build:
    image: node:24-alpine
    deps: [install]
    src: [src, tsconfig.json]
    generates: [dist]
    cmds: [npm run build]`;

export const ciAfter = `steps:
  - uses: actions/checkout@v4
  - uses: no0dles/hammerkit-github-action@v1
  - run: hammerkit run ci`;

export const installCommand = 'npm install --global hammerkit';
