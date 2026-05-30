import { defineConfig } from 'vitest/config'

// One config, two modes selected by `--mode`:
//   vitest run                    -> fast unit suite, no Docker/k8s required
//   vitest run --mode integration -> the slow container/k8s/service suites plus
//                                     the three heavy specs (docker/package, program)
// These used to be two files. The only real differences are include/exclude, the
// timeout, and the forks pool + pre-run cleanup — small enough to express as a
// `mode` branch, which keeps CI's split unit/integration jobs intact. Both jobs
// upload their coverage/lcov.info for the commit and Codacy combines the two.
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
      // Every spec belongs to exactly one mode: the unit run excludes precisely
      // what the integration run includes, and vice versa.
      include: integration
        ? ['src/testing/integration/**/*.spec.ts', 'src/docker/package.spec.ts', 'src/program.spec.ts']
        : ['src/**/*.spec.ts'],
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
        // Both modes write here. In CI the unit (test.yaml) and integration
        // (integration.yaml) jobs run on separate runners, so the shared name
        // never clobbers; each uploads its coverage/lcov.info for the commit and
        // Codacy combines the two reports into one figure.
        reportsDirectory: 'coverage',
      },
    },
  }
})
