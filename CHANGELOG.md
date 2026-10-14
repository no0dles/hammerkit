# [1.26.0](https://github.com/no0dles/hammerkit/compare/v1.25.0...v1.26.0) (2026-10-14)


### Features

* pass arguments to a task or service after -- ([#95](https://github.com/no0dles/hammerkit/issues/95)) ([52745e5](https://github.com/no0dles/hammerkit/commit/52745e5c4b3b88ebb9a320d6aa92b188c70600bf))

# [1.25.0](https://github.com/no0dles/hammerkit/compare/v1.24.0...v1.25.0) (2026-10-11)


### Features

* **server:** redesign remote compute around accounts, repositories and isolated runs ([#90](https://github.com/no0dles/hammerkit/issues/90)) ([8ddc5ae](https://github.com/no0dles/hammerkit/commit/8ddc5ae557a18c88c2d49e3ee6a003bd19f319c5))

# [1.24.0](https://github.com/no0dles/hammerkit/compare/v1.23.0...v1.24.0) (2026-10-11)


### Features

* remote compute server with OAuth, published build files and approvals ([#84](https://github.com/no0dles/hammerkit/issues/84)) ([8e6b382](https://github.com/no0dles/hammerkit/commit/8e6b38212499f634e48fe251cf8c534c6bfcd19a))

# [1.23.0](https://github.com/no0dles/hammerkit/compare/v1.22.0...v1.23.0) (2026-10-11)


### Features

* secret providers read as service accounts, per-run secret masking ([#85](https://github.com/no0dles/hammerkit/issues/85)) ([bd61b9d](https://github.com/no0dles/hammerkit/commit/bd61b9de48cec1b8f3c19c23d52059591c80c89a))

# [1.22.0](https://github.com/no0dles/hammerkit/compare/v1.21.2...v1.22.0) (2026-10-11)


### Features

* add tsc, eslint, prettier, jest and helm to the catalog and remove best-practices ([#88](https://github.com/no0dles/hammerkit/issues/88)) ([88661dd](https://github.com/no0dles/hammerkit/commit/88661dd8c8f735433c3da0e14b21349b7fcd2092))

## [1.21.2](https://github.com/no0dles/hammerkit/compare/v1.21.1...v1.21.2) (2026-10-11)


### Bug Fixes

* restore transitive dependencies when a dependent task re-runs ([#79](https://github.com/no0dles/hammerkit/issues/79)) ([3932a8b](https://github.com/no0dles/hammerkit/commit/3932a8b8d56d53db9bb0f9258df42894ab2f8d61))

## [1.21.1](https://github.com/no0dles/hammerkit/compare/v1.21.0...v1.21.1) (2026-10-11)


### Bug Fixes

* let fetch set content-length for registry blob uploads ([#77](https://github.com/no0dles/hammerkit/issues/77)) ([98c66f7](https://github.com/no0dles/hammerkit/commit/98c66f7f42647ebaf09517ade9f24ce2a9f11f02))

# [1.21.0](https://github.com/no0dles/hammerkit/compare/v1.20.0...v1.21.0) (2026-10-11)


### Features

* add docker to the catalog ([#75](https://github.com/no0dles/hammerkit/issues/75)) ([1a642d8](https://github.com/no0dles/hammerkit/commit/1a642d87e0bc3e3d2b66c347d0f1d0154f11ae2d))

# [1.20.0](https://github.com/no0dles/hammerkit/compare/v1.19.1...v1.20.0) (2026-10-11)


### Features

* add dotnet to the catalog ([#73](https://github.com/no0dles/hammerkit/issues/73)) ([0fe2132](https://github.com/no0dles/hammerkit/commit/0fe2132b2da441b4733459b2b5eb5f42b562a139))

## [1.19.1](https://github.com/no0dles/hammerkit/compare/v1.19.0...v1.19.1) (2026-10-11)


### Bug Fixes

* mount the go and cargo caches from the home directory ([#72](https://github.com/no0dles/hammerkit/issues/72)) ([37b060c](https://github.com/no0dles/hammerkit/commit/37b060c782966b33cb888f95d4de0a01a523d910))

# [1.19.0](https://github.com/no0dles/hammerkit/compare/v1.18.0...v1.19.0) (2026-10-10)


### Features

* add pip, go and cargo to the catalog ([#68](https://github.com/no0dles/hammerkit/issues/68)) ([f0c466a](https://github.com/no0dles/hammerkit/commit/f0c466ae394806772c13ec1abb2085fbb4fa6717))

# [1.18.0](https://github.com/no0dles/hammerkit/compare/v1.17.0...v1.18.0) (2026-10-10)


### Features

* explain --definition shows a task's resolved definition and where it came from ([#65](https://github.com/no0dles/hammerkit/issues/65)) ([55ab065](https://github.com/no0dles/hammerkit/commit/55ab06582ce802133e469b55e7bb71a740b87869))

# [1.17.0](https://github.com/no0dles/hammerkit/compare/v1.16.0...v1.17.0) (2026-10-10)


### Features

* includes pull refreshes remote includes, clean --cache purges them ([#64](https://github.com/no0dles/hammerkit/issues/64)) ([a76ae0e](https://github.com/no0dles/hammerkit/commit/a76ae0e694e7bd7fe92a51db39f91d22d7adb9af))

# [1.16.0](https://github.com/no0dles/hammerkit/compare/v1.15.0...v1.16.0) (2026-10-10)


### Features

* add a catalog of tested tasks with npm, yarn and pnpm install ([#63](https://github.com/no0dles/hammerkit/issues/63)) ([62992f8](https://github.com/no0dles/hammerkit/commit/62992f8328aa239130ed03ed46a713a5dc380c9f))

# [1.15.0](https://github.com/no0dles/hammerkit/compare/v1.14.1...v1.15.0) (2026-10-10)


### Features

* extend carries the base file's envs and can reset inherited values ([#62](https://github.com/no0dles/hammerkit/issues/62)) ([e02216e](https://github.com/no0dles/hammerkit/commit/e02216eb3419fabcb9e9a7778638c49ede4f3643))

## [1.14.1](https://github.com/no0dles/hammerkit/compare/v1.14.0...v1.14.1) (2026-10-10)


### Bug Fixes

* a task extending a chain of tasks inherits every base once ([#61](https://github.com/no0dles/hammerkit/issues/61)) ([33b5567](https://github.com/no0dles/hammerkit/commit/33b5567caafda74c9d594cb98f141ba5b217f598))

# [1.14.0](https://github.com/no0dles/hammerkit/compare/v1.13.1...v1.14.0) (2026-10-10)


### Features

* include build files from a git repository, with inputs ([#60](https://github.com/no0dles/hammerkit/issues/60)) ([1eaf6bd](https://github.com/no0dles/hammerkit/commit/1eaf6bd3449dbc4cb36a7e1f901d5f0811de3d4b)), closes [#26](https://github.com/no0dles/hammerkit/issues/26)

## [1.13.1](https://github.com/no0dles/hammerkit/compare/v1.13.0...v1.13.1) (2026-10-10)


### Bug Fixes

* clean without a Docker daemon ([#57](https://github.com/no0dles/hammerkit/issues/57)) ([6fd2be4](https://github.com/no0dles/hammerkit/commit/6fd2be4c12a5fb1993d538723e68bf4106d8b88f))

# [1.13.0](https://github.com/no0dles/hammerkit/compare/v1.12.0...v1.13.0) (2026-10-10)


### Features

* **cli:** explain --check exits 1 when a task would be a cache miss ([#56](https://github.com/no0dles/hammerkit/issues/56)) ([e137189](https://github.com/no0dles/hammerkit/commit/e137189a13ec4f707d827f06300e6b2f4e5ab5db))

# [1.12.0](https://github.com/no0dles/hammerkit/compare/v1.11.3...v1.12.0) (2026-10-10)


### Features

* container resource requests and limits ([#53](https://github.com/no0dles/hammerkit/issues/53)) ([05bf33d](https://github.com/no0dles/hammerkit/commit/05bf33decc008e222eb1767738045e82b05e9798)), closes [#18](https://github.com/no0dles/hammerkit/issues/18)
