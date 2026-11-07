# The dashboard

The pages a hammerkit server shows at `https://hammerkit.<domain>`: a React app (Vite,
Tailwind CSS) that reads and does everything through the server's API, as the person who
signed in. The server serves it from `dist/dashboard` (`src/server/dashboard.ts`), and its host
passes `/api/v1/...` on to `/v1/...` of the API for the paths the pages need.

The app shares its types and a few helpers (times, CPU and memory, why a run waits) with
`src/server`, so the root `node_modules` has to be installed for its type check.

```sh
npm ci && npm run build:dashboard   # into dist/dashboard, which the server and the binaries take
npm run dev --prefix dashboard      # http://localhost:5173 against a local server:
                                    # HAMMERKIT_DASHBOARD=http://hammerkit.localhost:8480
                                    # HAMMERKIT_TOKEN=<a token the server accepts>
```

Docs: `website/content/docs/remote-compute/status.mdx#dashboard`.
