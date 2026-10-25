# [1.27.0-next.15](https://github.com/no0dles/hammerkit/compare/v1.27.0-next.14...v1.27.0-next.15) (2026-10-25)


### Bug Fixes

* a service run stopped by the server shutting down fails, with why ([294e59b](https://github.com/no0dles/hammerkit/commit/294e59bad8c6d0c38bd651239b0a98656562383e))
* a service with more than one port starts on Kubernetes ([b2277a1](https://github.com/no0dles/hammerkit/commit/b2277a16a833f5f3e074b2172e5f5d96bb2d4597))
* a wake of a service run checks its owner's rights; review round 2 ([9ad7843](https://github.com/no0dles/hammerkit/commit/9ad78439c783ce8930cefcfe95a62db263067156))
* log refused endpoint upgrades; test a browser's WebSocket with the sign-in cookie ([1d4a050](https://github.com/no0dles/hammerkit/commit/1d4a050004fbd86e118d7ab2c9e42c846446caac))


### Features

* cli and agent tools for service runs, tests (wip) ([c72f7d8](https://github.com/no0dles/hammerkit/commit/c72f7d86135c021d24bd8dfbbd74279715935e1e))
* service runs sleep without requests and wake on a visit; first review round ([21ac262](https://github.com/no0dles/hammerkit/commit/21ac2629e07c58e6fb56d1c467a4cdfe8ec51284)), closes [#118](https://github.com/no0dles/hammerkit/issues/118)
* service runs with endpoints behind the server's sign-in (wip) ([adbd63c](https://github.com/no0dles/hammerkit/commit/adbd63cbc8c9a0d27d3a5e28f68c08e3c1c438f3))

# [1.27.0-next.14](https://github.com/no0dles/hammerkit/compare/v1.27.0-next.13...v1.27.0-next.14) (2026-10-25)


### Bug Fixes

* review of the task tools: their turn tested, shell guardrail documented ([9670445](https://github.com/no0dles/hammerkit/commit/967044599ea93338c2d0732f59107296b1efa2b3))


### Features

* run_task and run_logs in the opencode plugin, and no shell task needed ([f6331c2](https://github.com/no0dles/hammerkit/commit/f6331c21fcb0a224738468aa87aeb7756675d663))

# [1.27.0-next.13](https://github.com/no0dles/hammerkit/compare/v1.27.0-next.12...v1.27.0-next.13) (2026-10-25)


### Bug Fixes

* check the runner's mounts before each command ([4163726](https://github.com/no0dles/hammerkit/commit/416372663cec0533ffe04f69fe2d164e48c65eb4))
* clean up the sandbox runner with a busybox commands can not replace ([95a3cb1](https://github.com/no0dles/hammerkit/commit/95a3cb158f035f85afa0fc4a5c606767ed8382fe))
* keep one runner for the runs of a sandbox ([5ea7737](https://github.com/no0dles/hammerkit/commit/5ea7737630e4c856e35c51db928b0d5aa093a406))
* keep starting the runner when its command stops meanwhile ([586a097](https://github.com/no0dles/hammerkit/commit/586a097136bf7c132cf3bb0fab4a43eecb0fe79a))
* leave the sandbox's files alone when they are below /tmp in the runner ([fb3716e](https://github.com/no0dles/hammerkit/commit/fb3716ee0473843d00f6fe734b3f81387b0e47fb))
* use the runner only for tasks that mount the whole sandbox ([90f4c5f](https://github.com/no0dles/hammerkit/commit/90f4c5f571c285c0b8630d11419f2384acc1766d))


### Features

* run sandbox commands in a warm runner pod on kubernetes ([81e4a01](https://github.com/no0dles/hammerkit/commit/81e4a01199180cd6d7300579f8bd79625b55e8c6))

# [1.27.0-next.12](https://github.com/no0dles/hammerkit/compare/v1.27.0-next.11...v1.27.0-next.12) (2026-10-25)


### Bug Fixes

* cover the gzip archive in the empty linked file specs ([0ecd29f](https://github.com/no0dles/hammerkit/commit/0ecd29f6df85f6f1a0a03d8b624ef48b6bd10551))
* keep node-tar from ending an archive twice on an empty linked file ([1a062d6](https://github.com/no0dles/hammerkit/commit/1a062d660caa2b28e696fd47b067d6650fed5e5e)), closes [#117](https://github.com/no0dles/hammerkit/issues/117)
* set no deadline for a timeout longer than a timer can wait ([c23b693](https://github.com/no0dles/hammerkit/commit/c23b6933892a4465247e5bc97c55bacf29988719))


### Features

* cap every task of a run with --max-timeout ([ac4a6c1](https://github.com/no0dles/hammerkit/commit/ac4a6c193a6567a935a3b72df33fae2083e3811e))

# [1.27.0-next.11](https://github.com/no0dles/hammerkit/compare/v1.27.0-next.10...v1.27.0-next.11) (2026-10-25)


### Bug Fixes

* cover the gzip archive in the empty linked file specs ([6e8086f](https://github.com/no0dles/hammerkit/commit/6e8086fdba350aefb59d2b72bca92d3b623f67f4))
* keep node-tar from ending an archive twice on an empty linked file ([6c8f8df](https://github.com/no0dles/hammerkit/commit/6c8f8df363b9334a4464a131befe732782936d2c)), closes [#117](https://github.com/no0dles/hammerkit/issues/117)

# [1.27.0-next.10](https://github.com/no0dles/hammerkit/compare/v1.27.0-next.9...v1.27.0-next.10) (2026-10-25)


### Bug Fixes

* note that Windows archives can grow, and place the link cache comment ([2e504ca](https://github.com/no0dles/hammerkit/commit/2e504ca73b81cd58ace5857cb0416faf7bda9b32)), closes [#117](https://github.com/no0dles/hammerkit/issues/117)
* pack a hard link as a link only when its file id is exact ([fdcb03d](https://github.com/no0dles/hammerkit/commit/fdcb03d8ee87de3cdd46d948adc7c319d719e8bf))

# [1.27.0-next.9](https://github.com/no0dles/hammerkit/compare/v1.27.0-next.8...v1.27.0-next.9) (2026-10-25)


### Features

* run the runs of one caller side by side on Kubernetes ([a54f5bd](https://github.com/no0dles/hammerkit/commit/a54f5bdd0a8805bbf0fd39712c298f4c32818ae3))

# [1.27.0-next.8](https://github.com/no0dles/hammerkit/compare/v1.27.0-next.7...v1.27.0-next.8) (2026-10-25)


### Bug Fixes

* name sandbox commits by their email and keep k8s setup out of task output ([#115](https://github.com/no0dles/hammerkit/issues/115)) ([f0f81fc](https://github.com/no0dles/hammerkit/commit/f0f81fc46e8ab6fc2e374a62fac2f5abf34d480c))

# [1.27.0-next.7](https://github.com/no0dles/hammerkit/compare/v1.27.0-next.6...v1.27.0-next.7) (2026-10-25)


### Bug Fixes

* pack archives one file at a time to avoid node-tar's hard link hang ([52902b5](https://github.com/no0dles/hammerkit/commit/52902b5115defd1c282256178b838505399373b0))
* pack every archive through packArchive and test that links survive ([3c78ee1](https://github.com/no0dles/hammerkit/commit/3c78ee1d1e80aa7c68c07735b377a0cfb4c7f61f))

# [1.27.0-next.6](https://github.com/no0dles/hammerkit/compare/v1.27.0-next.5...v1.27.0-next.6) (2026-10-24)


### Bug Fixes

* give a task whose outputs shared one cache archive a new id too ([aee0d10](https://github.com/no0dles/hammerkit/commit/aee0d1073c664ae833e65b392863680778451de7)), closes [#112](https://github.com/no0dles/hammerkit/issues/112)
* give each output of a task its own folder in its Kubernetes claim ([969d2b1](https://github.com/no0dles/hammerkit/commit/969d2b16b193aa6dc8274e5c7818f710feea6a79))
* name claim folders by the path in the project, whatever the run's directory or order ([f0727f5](https://github.com/no0dles/hammerkit/commit/f0727f517c3cf3f8f4279404799af7494b10116d))

# [1.27.0-next.5](https://github.com/no0dles/hammerkit/compare/v1.27.0-next.4...v1.27.0-next.5) (2026-10-24)


### Bug Fixes

* keep the proxy token out of secret references and pin it to the init containers ([3f4c0e8](https://github.com/no0dles/hammerkit/commit/3f4c0e811e670d0ace0aab1d5c792d781c17bbd2))


### Features

* close agents' ways out with per-task args and a network ceiling for secret tasks ([29dcf68](https://github.com/no0dles/hammerkit/commit/29dcf6821b509946aff4d85814e71b8b68211c2f))

# [1.27.0-next.4](https://github.com/no0dles/hammerkit/compare/v1.27.0-next.3...v1.27.0-next.4) (2026-10-24)


### Bug Fixes

* keep `hammerkit server` running on SIGHUP, which reloads its entitlements ([80c0c5b](https://github.com/no0dles/hammerkit/commit/80c0c5b3083f0d8a49b0eb7a6383b0b2a614956c))
* keep a SIGHUP while the server starts and give it back on every exit ([73556d5](https://github.com/no0dles/hammerkit/commit/73556d563d293c10d7faac861d7321ac69dff634))

# [1.27.0-next.3](https://github.com/no0dles/hammerkit/compare/v1.27.0-next.2...v1.27.0-next.3) (2026-10-24)


### Bug Fixes

* **remote:** remote run waits for the cancel to reach the server, CI guide hardening from review ([7796118](https://github.com/no0dles/hammerkit/commit/779611862e149e26a57d0e9463c2462be57e349e))


### Features

* **remote:** remote run starts a run of a published build file from a git ref and follows it ([5839c39](https://github.com/no0dles/hammerkit/commit/5839c39fe00a9acd17ae9b303e26e1ca462dd843))

# [1.27.0-next.2](https://github.com/no0dles/hammerkit/compare/v1.27.0-next.1...v1.27.0-next.2) (2026-10-21)


### Bug Fixes

* **cli:** show why github-app-token failed, print the bare version, and the day of the month in logs ([280911f](https://github.com/no0dles/hammerkit/commit/280911f097997da57e6045a1c3b9cc3560150a5a))
* **server:** sweep only this server's caller namespaces, and review fixes to the agent guides ([13eb9d5](https://github.com/no0dles/hammerkit/commit/13eb9d51309f4a56d26c7f1064f3d2ab4b37b630))

# [1.27.0-next.1](https://github.com/no0dles/hammerkit/compare/v1.26.0...v1.27.0-next.1) (2026-10-19)


### Bug Fixes

* address review of the agent clients ([9d93a33](https://github.com/no0dles/hammerkit/commit/9d93a332fd3636b95e768c2c9b7ed3ed64c41309))
* agent clients take parallel calls in turns and never fall back to local tools ([d0e4a5b](https://github.com/no0dles/hammerkit/commit/d0e4a5bfb3467939ca136faca808a7f616090647))
* delete the network policies of an item by name ([3605726](https://github.com/no0dles/hammerkit/commit/360572633087065cfacde50b0c3a22e911818ab9))
* hand local commands the PATH of the process on Windows ([126d79c](https://github.com/no0dles/hammerkit/commit/126d79c1b21fa28a27c96c19b7d9f611997902cd))
* **harness:** say why the server could not be reached ([15d1d02](https://github.com/no0dles/hammerkit/commit/15d1d022b371f82c4b1e085eeebcb44811cb749d))
* keep a forward a ceiling allows through a pattern off private addresses ([4c78046](https://github.com/no0dles/hammerkit/commit/4c78046b3aadc08c04acd0c687ecbf29f088dc47))
* keep need names out of the proxy's patterns and gate limited pods ([daa7aec](https://github.com/no0dles/hammerkit/commit/daa7aecb40144996eed3b4876e40a8dd5b94716c))
* **kubernetes:** hold a limited pod back until its network policy holds ([5cc4348](https://github.com/no0dles/hammerkit/commit/5cc43488a22775593d4eafc773fbc5dac9bc7d03)), closes [#98](https://github.com/no0dles/hammerkit/issues/98)
* **kubernetes:** isolate the namespaces of callers and narrow the server's rights ([ddfb8cf](https://github.com/no0dles/hammerkit/commit/ddfb8cfbc11630b340ed706f6d9e6ecbb1759a77))
* **kubernetes:** label runs with a value every run id can have ([b86327d](https://github.com/no0dles/hammerkit/commit/b86327d6d0e13ad1c25c4dd1047d8f1d673fefdb))
* **kubernetes:** restore cached outputs into a claim made for the run ([f362b71](https://github.com/no0dles/hammerkit/commit/f362b71795ddf1edd10b68a125be2401b73af5e3))
* let down stop a service on a kubernetes environment ([58f860d](https://github.com/no0dles/hammerkit/commit/58f860d77dffde5bc80b943d10f0cd46a4c3f80e))
* let the egress proxy try every checked address of a host ([60cc671](https://github.com/no0dles/hammerkit/commit/60cc671a8b870e9db72c0e431b79eabfb102d641))
* let the egress proxy try every checked address of a host ([64fd7e8](https://github.com/no0dles/hammerkit/commit/64fd7e81be3fea4e32f459626c635638a66bc67c))
* make network limits hold on Docker and Kubernetes ([26013b0](https://github.com/no0dles/hammerkit/commit/26013b0783046e50bf4770aad12f04de795c182e))
* reach a Kubernetes service without ports and report why a task failed there ([82e78ad](https://github.com/no0dles/hammerkit/commit/82e78adf6c951869f2003b98c8b73f7c6925aee9))
* read secrets in a Kubernetes Job again from the compiled CLI ([112bcee](https://github.com/no0dles/hammerkit/commit/112bcee2e44a123a7b7d29a35d8cb791a539a5ac))
* refuse arguments for tasks holding server credentials, show approvers everything ([9fa272e](https://github.com/no0dles/hammerkit/commit/9fa272e7a84c99227405d537151c0945d36c833e))
* refuse arguments when any item of the run reads a secret ([56aac39](https://github.com/no0dles/hammerkit/commit/56aac39ebdeddcc16194815d8707e804b37cef48))
* **remote:** ask git where the build file is in its repository ([79ce955](https://github.com/no0dles/hammerkit/commit/79ce95551e5617318b473597aec51bef1506aac7))
* **remote:** mark versions published from changed files, show published versions ([531e589](https://github.com/no0dles/hammerkit/commit/531e5895b7c7d4a20e59d1e92f4df0eda67ebebf))
* **remote:** show a decided proposal instead of failing on its dropped files ([f1ea366](https://github.com/no0dles/hammerkit/commit/f1ea366fb82ae77414aba7bee242cf4272878819))
* say why an allowed host's https URL fails through the egress proxy ([de550b4](https://github.com/no0dles/hammerkit/commit/de550b4d8c407048f1994f745f066c847982d2b5))
* **secrets:** run the release binary as its own secret provider ([ea40131](https://github.com/no0dles/hammerkit/commit/ea40131449170a918bc0b1ba74c18a740f78487b))
* **server:** back up a failed taskkill and report a leftover run directory to the operator ([2a4bf5a](https://github.com/no0dles/hammerkit/commit/2a4bf5afcb462e837b63f48295fa344b3a4905c2))
* **server:** bound the claims of tasks, and free the kept ones a run does not use ([a91aa77](https://github.com/no0dles/hammerkit/commit/a91aa77bc9f0f29f96e27580917364ba7eacceb2))
* **server:** cancel a run on its standard input instead of with taskkill ([c2def11](https://github.com/no0dles/hammerkit/commit/c2def110e7ad8326529ff1d91c53306245fbc7e1))
* **server:** close the sandbox findings of the harness review ([4aad249](https://github.com/no0dles/hammerkit/commit/4aad2490011e4ca241728436bb620bc910a1344f))
* **server:** combine the network ceilings of a sandbox run in its process ([0c6798a](https://github.com/no0dles/hammerkit/commit/0c6798a5c7f4574d84beba12edee72db61f9f6f5))
* **server:** count same-second edits of a sandbox as changes ([74a8ab9](https://github.com/no0dles/hammerkit/commit/74a8ab917a9d40c2a0e6f25472ec7d9f95f0c29c))
* **server:** date the copied index like the original, as the harness clients do ([7b40148](https://github.com/no0dles/hammerkit/commit/7b40148c1327f2114b517805172cda8a9e2f1261))
* **server:** index run logs once, keep task outcomes across scopes ([5c3bafd](https://github.com/no0dles/hammerkit/commit/5c3bafd662d1e13c76e0d47df601ef98f144b7de))
* **server:** keep a cancelled run's outcome when Windows holds its directory ([f9b4ca5](https://github.com/no0dles/hammerkit/commit/f9b4ca5e9a6f478529a07dd94060a799bd758ed4)), closes [#84](https://github.com/no0dles/hammerkit/issues/84)
* **server:** keep a cancelled run's outcome when Windows holds its directory ([9a74fcf](https://github.com/no0dles/hammerkit/commit/9a74fcfb16793685a34ae57486e7a1c8588cdfcd))
* **server:** keep a Kubernetes sandbox's git data out of what tasks mount, and push from it ([a23bae3](https://github.com/no0dles/hammerkit/commit/a23bae319abf7141444858b87f9cb7c14e518b6d))
* **server:** keep a sandbox's files as committed whatever the machine's line endings ([f02dfc5](https://github.com/no0dles/hammerkit/commit/f02dfc5733f16fdbb5d2b326ef993e838f339cad))
* **server:** keep a service's inherited outputs under their names on a scoped run ([b6a6f38](https://github.com/no0dles/hammerkit/commit/b6a6f3819f86609d9a4029d55677c89d786c8337))
* **server:** keep runs of different callers apart on a shared server ([681b56e](https://github.com/no0dles/hammerkit/commit/681b56e1f9cd7c880a9116197f9889ce1ef7f25a))
* **server:** label the pod of a sandbox's files as limited, so no default policy of its namespace selects it ([c34a1e3](https://github.com/no0dles/hammerkit/commit/c34a1e386a74653bf42843f04f2f1b644d44a98e))
* **server:** leave hammerkit's run state out of a sandbox's changes ([0e13332](https://github.com/no0dles/hammerkit/commit/0e13332f2b93baf1a98751a5a2030562cec78e1d))
* **server:** let nothing into an egress proxy that its own policy does not let in ([e66cd73](https://github.com/no0dles/hammerkit/commit/e66cd7370e8ce0ce74ce00060b34e9a3868e9d10))
* **server:** name the empty global git config so git for Windows opens it ([c34efc9](https://github.com/no0dles/hammerkit/commit/c34efc9ab1d6dc1f31c7e4f2d518873882ad6819))
* **server:** need networkPolicy enforced for limited sandbox runs on Kubernetes ([99f0e5a](https://github.com/no0dles/hammerkit/commit/99f0e5a95423a97cd6b6963d65eb1c0d478a275d))
* **server:** point the sandbox read at a missing git config, as the file API does ([ce66ea5](https://github.com/no0dles/hammerkit/commit/ce66ea57f6540245c5c375eb87cc821e10e758c7))
* **server:** push only with the source's own credential ([e48c369](https://github.com/no0dles/hammerkit/commit/e48c3696fbc227a09a410605b21ed408be00bf25))
* **server:** read a sandbox's files with an empty git config on Windows too ([8b9a58a](https://github.com/no0dles/hammerkit/commit/8b9a58a70d3b44bb7902f107a3cd3df46c0cd2c8))
* **server:** read sandboxes without a global git config on Windows too ([b1c3dd5](https://github.com/no0dles/hammerkit/commit/b1c3dd5669cb75f4e2fa0e7747d7691d1945e0c6))
* **server:** refuse a kubernetes sandbox commit with hammerkit's run state ([cfeb761](https://github.com/no0dles/hammerkit/commit/cfeb7616929ac4f3c6b324f70c8ee57bd52e0455))
* **server:** refuse paths of a run outside its source or through a link ([638d0e2](https://github.com/no0dles/hammerkit/commit/638d0e2ee199560b95c4fe8681ed2f1607629af0))
* **server:** refuse pipes, alternate credential names and nested repos in sandbox files ([6d8d1f5](https://github.com/no0dles/hammerkit/commit/6d8d1f5b9e65db230c53acfc5c4cf31b2c40b54e))
* **server:** remove the egress proxies of a sandbox that no files pod owns ([0e570db](https://github.com/no0dles/hammerkit/commit/0e570db1a52cdf79163aea10ff5d3ac9c52b0806))
* **server:** sandbox review fixes, work in progress ([fcbb543](https://github.com/no0dles/hammerkit/commit/fcbb543bccc78e1b75f6ef3ae4dde55c161b9185))
* **server:** say why the remote refused a sandbox push ([663fd5f](https://github.com/no0dles/hammerkit/commit/663fd5fd28d75b98ebbf7300bb62a0056f27367d))
* **server:** slash paths from ripgrep's JSON on Windows ([bc81400](https://github.com/no0dles/hammerkit/commit/bc814001cf0d684ae33183dc60c18c0573ddb9b5))
* **server:** write a link in a sandbox as a link when reading its tree ([69baee2](https://github.com/no0dles/hammerkit/commit/69baee2b1d1292f14c5aab81eab435d08d6911b6))
* take a link on a server as the link when hashing sources ([a88f8fc](https://github.com/no0dles/hammerkit/commit/a88f8fc4f981bd0e35a6884d200c85c321c21d39))
* wait out kind's late network policy in the kubernetes network spec ([85b7043](https://github.com/no0dles/hammerkit/commit/85b704388fb5d4bfc515204abacd807530f694fe))


### Features

* agent harness clients for sandboxes (hammerkit mcp, pi, opencode) ([776e62a](https://github.com/no0dles/hammerkit/commit/776e62aa770ab238f03ff45eb9261ae970710a2b))
* arguments and network ceilings for server runs ([07e0d9c](https://github.com/no0dles/hammerkit/commit/07e0d9ca5f46b708806a8eae1755e3be006ab425))
* forward raw TCP to a host and port of an allow list ([1bc68b5](https://github.com/no0dles/hammerkit/commit/1bc68b5bf64521f933982fadf17fa621d7512c11))
* **harness:** opencode 2 plugin, with opencode 1 kept through server ([4e68a36](https://github.com/no0dles/hammerkit/commit/4e68a3668852cf67685d27158f8b9de09fec1ef2))
* **harness:** the agent clients pin the hash of a published version ([6707478](https://github.com/no0dles/hammerkit/commit/670747889032386e14e8e6344fe9dd0883dbfa2c)), closes [#94](https://github.com/no0dles/hammerkit/issues/94)
* **kubernetes:** set the size of the claim of a task or service ([80f8a2f](https://github.com/no0dles/hammerkit/commit/80f8a2f732025c6ca7915e153b9a61c220f4714b))
* network limits for tasks and services ([fc30a62](https://github.com/no0dles/hammerkit/commit/fc30a6288b349bafb22c00cb42f69b186d21f45d))
* pass arguments to a task or service after -- ([392916b](https://github.com/no0dles/hammerkit/commit/392916b1d388623a227512395a38a5e5d15857a2))
* push from the agent clients, and token variables for remote commands ([5e04b73](https://github.com/no0dles/hammerkit/commit/5e04b73c6eb32bd0ba478a796f33fab34beec14e))
* **server:** a pull or push type per branch in sandbox grants ([313410f](https://github.com/no0dles/hammerkit/commit/313410f43587d7d36c77f94eed2248fe8e65fb21)), closes [#93](https://github.com/no0dles/hammerkit/issues/93)
* **server:** annotate published build files with where they come from ([e193aec](https://github.com/no0dles/hammerkit/commit/e193aeca64aec6c9a1809126526cea95fd8c6f4c))
* **server:** grant sandboxes per repository on the entitlement ([5f36f6a](https://github.com/no0dles/hammerkit/commit/5f36f6aab19c634180f880b78f1d35fc4e36eaab)), closes [#93](https://github.com/no0dles/hammerkit/issues/93)
* **server:** keep sandboxes as claims on a Kubernetes backend ([ef2c592](https://github.com/no0dles/hammerkit/commit/ef2c5921b7929156e314efbc3b837e49fb2bbcad))
* **server:** keep the claims of tasks between the runs of a source ([2d38c09](https://github.com/no0dles/hammerkit/commit/2d38c09af94338193d9c4c6e39b58da3edfa861b))
* **server:** limit the network of Jobs on a Kubernetes backend ([0af378d](https://github.com/no0dles/hammerkit/commit/0af378d1330b7464c81cdfc890a0936139ebc95a)), closes [#98](https://github.com/no0dles/hammerkit/issues/98)
* **server:** mint GitHub App tokens with hammerkit github-app-token ([fef914d](https://github.com/no0dles/hammerkit/commit/fef914d97120b0b8fd380f8998d959b83dd35402))
* **server:** name published build files by their hash only ([187f138](https://github.com/no0dles/hammerkit/commit/187f13861990cf310cec2551afb0e29ee4e6649d))
* **server:** per-task run results, wait and log reads ([61300a6](https://github.com/no0dles/hammerkit/commit/61300a6f8872e481a1eb50ad9040172d5b26a851))
* **server:** push sandboxes with the source's secret ([b374826](https://github.com/no0dles/hammerkit/commit/b374826d1f3e215cba981f4f8e1d1036670b6b94))
* **server:** push the changes of a sandbox to an allowed branch ([c52b016](https://github.com/no0dles/hammerkit/commit/c52b01652eb77b821db3e9a7e20273d1d2126600))
* **server:** push to the branches an entitlement types push, with the source's pushSecret ([0a8911b](https://github.com/no0dles/hammerkit/commit/0a8911ba8e6aabd2a58bc536e219a74424cb26dd))
* **server:** read, search and edit the files of a sandbox ([1484173](https://github.com/no0dles/hammerkit/commit/14841730446e842cb3f5cb1b8e1dad6980b014c9))
* **server:** run tasks as Jobs on a Kubernetes backend ([dabb1e1](https://github.com/no0dles/hammerkit/commit/dabb1e1d54e46ad799f54af1435ee79d13921a75))
* **server:** sandboxes on a host ([21080a8](https://github.com/no0dles/hammerkit/commit/21080a8e354bb67c5ee30c1e3c1bfbcd47d06734))
* skip the cache for a run with arguments ([0f92c77](https://github.com/no0dles/hammerkit/commit/0f92c77c81626bed4a349beb2e06568d2d5ca1fe))


### Performance Improvements

* don't hash the sources of a task whose cache is off ([118af0b](https://github.com/no0dles/hammerkit/commit/118af0bb203450aadc177f868f2b6eae9523251b))
* keep a sandbox's files pod while its runs work on a cluster ([6d7fab7](https://github.com/no0dles/hammerkit/commit/6d7fab700fe6f888559c57ea457b441a435b6d9c))
* **server:** keep a task's egress proxy on a sandbox for its next runs ([f4dafa7](https://github.com/no0dles/hammerkit/commit/f4dafa7cad455e7cbfa86ee9abfc0553cc9adf9c))
* **server:** walk a sandbox in parallel, and once per run ([715e758](https://github.com/no0dles/hammerkit/commit/715e758429252ab2d053a20013635618450bb344))
* **server:** walk a sandbox once per run, and answer before measuring it ([3811101](https://github.com/no0dles/hammerkit/commit/3811101f7b51bfe25d7788f15fccebcaedf7cd91))

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
