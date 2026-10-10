// Code shown on the landing page.

export const buildFile = `caches:
  shared:
    method: checksum
    backend:
      type: registry
      repository: ghcr.io/my-org/hammerkit-cache

tasks:
  install:
    image: node:24-alpine
    src: [package.json, package-lock.json]
    generates: [node_modules]
    cmds: [npm ci]

  test:
    image: node:24-alpine
    deps: [install]
    src: [src, test]
    cmds: [npm test]

  build:
    image: node:24-alpine
    deps: [install]
    src: [src, tsconfig.json]
    generates: [dist]
    cmds: [npm run build]

  ci:
    deps: [test, build]`;

export const githubCi = `permissions:
  contents: read
  packages: write   # push to the cache in GHCR
steps:
  - uses: actions/checkout@v4
  - uses: no0dles/hammerkit-github-action@v1
  - uses: docker/login-action@v3
    with:
      registry: ghcr.io
      username: \${{ github.actor }}
      password: \${{ secrets.GITHUB_TOKEN }}
  - run: hammerkit cache pull --remote shared
  - run: hammerkit run ci
  - run: hammerkit cache push --remote shared`;

export const gitlabCi = `ci:
  image:
    name: no0dles/hammerkit
    entrypoint: ['']
  services:
    - docker:dind
  variables:
    DOCKER_HOST: tcp://docker:2375
    DOCKER_TLS_CERTDIR: ''
  before_script:
    - echo "$CI_REGISTRY_PASSWORD" |
        docker login $CI_REGISTRY -u $CI_REGISTRY_USER --password-stdin
    - hammerkit cache pull --remote shared
  script:
    - hammerkit run ci
  after_script:
    - hammerkit cache push --remote shared`;

// On GitLab the shared cache lives in the project's own container registry.
export const gitlabBuildFile = buildFile.replace(
  'ghcr.io/my-org/hammerkit-cache',
  'registry.gitlab.com/my-group/my-project/hammerkit-cache'
);

export const installCommand = 'npm install --global hammerkit';
