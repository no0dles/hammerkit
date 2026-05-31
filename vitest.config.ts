import { defineConfig } from 'vitest/config'

// One config, two modes selected by `--mode`:
//   vitest run                    -> fast unit suite only, no Docker/k8s required
//   vitest run --mode integration -> the ENTIRE suite: the fast unit specs PLUS the
//                                     slow container/k8s/service suites and the heavy
//                                     specs (docker/package, program).
// These used to be two files. The only real differences are include/exclude, the
// timeout, and the forks pool + pre-run cleanup — small enough to express as a
// `mode` branch, which keeps CI's split unit/integration jobs intact. Integration
// mode is a superset of unit mode: its single coverage/lcov.info is the only report
// uploaded to Codacy, so it must run everything to report a complete figure. The
// unit-mode run (windows job) is platform coverage only and is not uploaded.
export default defineConfig(({ mode }) => {
  const integration = mode === 'integration'
  return {
    test: {
      globals: true,
      environment: 'node',
      // Native runners finish each unit spec well under a minute, so a short
      // default surfaces a genuine hang quickly. The integration run is slower and
      // raises this on emulated/self-hosted CI via HAMMERKIT_TEST_TIMEOUT.
      testTimeout: integration ? Number(process.env.HAMMERKIT_TEST_TIMEOUT) || 120000 : 45000,
      // Integration beforeAll/afterAll hooks provision real infra (e.g. a docker
      // registry container in docker-package-registry.spec.ts) — just as slow as the
      // tests themselves. Vitest's 10s hook default is far too tight for an emulated
      // colima daemon, so give hooks the same generous budget as integration tests.
      hookTimeout: integration ? Number(process.env.HAMMERKIT_TEST_TIMEOUT) || 120000 : 10000,
      // Integration mode runs every spec (unit + container/k8s + heavy specs) so its
      // lcov is a complete coverage report. Unit mode runs only the fast specs: it
      // excludes precisely the docker/k8s/heavy specs the integration-only path adds.
      include: ['src/**/*.spec.ts'],
      exclude: integration
        ? ['**/node_modules/**']
        : ['**/node_modules/**', 'src/testing/integration/**', 'src/docker/package.spec.ts', 'src/program.spec.ts'],
      // Integration only: remove leftover containers/namespaces from a prior
      // (possibly interrupted) run before starting — see the header of
      // scripts/integration-clean.js — and cap parallelism to 2 forks, since the
      // self-hosted runner shares one docker daemon and one k8s cluster.
      ...(integration
        ? {
            globalSetup: ['./scripts/integration-clean.js'],
            pool: 'forks',
            poolOptions: { forks: { maxForks: 2, minForks: 1 } },
          }
        : {}),
      reporters: process.env.GITHUB_ACTIONS ? ['default', 'github-actions'] : ['default'],
      coverage: {
        // istanbul (not v8) keeps the line/branch numbers comparable to the old
        // ts-jest report and produces the lcov that Codacy ingests.
        provider: 'istanbul',
        enabled: true,
        include: ['src/**'],
        // Exclude test-only code: the integration harness, spec/declaration files,
        // and src/index.ts (the bin entry just wires runProgram(process.argv)).
        exclude: ['src/testing/**', 'src/index.ts', '**/*.spec.ts', '**/*.d.ts'],
        reporter: integration ? ['lcov'] : ['json', 'html', 'lcov'],
        // Integration mode runs the full suite, so its lcov is the single, complete
        // report uploaded to Codacy (see the ubuntu job in test.yaml). The unit-mode
        // run (windows job) writes here too but is platform coverage only — not
        // uploaded — so the shared name never clobbers across the separate runners.
        reportsDirectory: 'coverage',
      },
    },
  }
})
