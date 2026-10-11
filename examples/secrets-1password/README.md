# Secret providers playground (1Password)

Tries the secret providers against a real 1Password. It uses local tasks, so it needs the
[1Password CLI](https://developer.1password.com/docs/cli/get-started/) (`op`) and Node, no Docker (only the optional
`container` task does).

CI runs it too: [secrets-1password.spec.ts](../../src/testing/integration/secrets-1password.spec.ts) copies this
folder and checks every row of the table in section 3 against the demo vaults of section 1. It fails, it does not
skip, when the tokens below are missing. See [CI](#4-ci) for what to set.

## 1. Two demo vaults (one time, about 10 minutes)

Use an account or vault set of its own, with nothing else in it. The two service accounts mirror the two Google
service accounts of [secrets-gsm](../secrets-gsm/README.md): each one reads one vault and nothing else.

In the 1Password app or on the web:

1. Create the vault `hammerkit-demo` with an item `playground` (category Password) whose `password` field is
   `demo-value-one`.
2. Create the vault `hammerkit-demo-other` with an item `playground` whose `password` field is `other-value`.
3. Under Developer > Service Accounts, create `hammerkit-demo-reader` with read access to `hammerkit-demo` only, and
   `hammerkit-demo-other` with read access to `hammerkit-demo-other` only. The token of a service account is shown
   once: store each in a file of its own, for example `reader.token` and `other.token`.

The same with the CLI, signed in as a person who may create vaults and service accounts (check `op ... --help`,
the flags change between versions):

```sh
op vault create hammerkit-demo
op vault create hammerkit-demo-other
op item create --category=password --title=playground --vault=hammerkit-demo password=demo-value-one
op item create --category=password --title=playground --vault=hammerkit-demo-other password=other-value
op service-account create hammerkit-demo-reader --vault hammerkit-demo:read_items --raw > reader.token
op service-account create hammerkit-demo-other  --vault hammerkit-demo-other:read_items --raw > other.token
```

Delete the service accounts and vaults when you are done.

## 2. Run it yourself

```sh
npm ci && npm run build     # in the hammerkit checkout
cd examples/secrets-1password   # the folder with .hammerkit.yaml; elsewhere hk only offers init and help
alias hk='node /path/to/hammerkit/dist/index.js'

export OP_TEST_TOKEN=$(cat reader.token)
export OP_OTHER_TOKEN=$(cat other.token)
export PLAYGROUND_OP_CONFIG=$(mktemp -d)     # empty op config: no signed-in session can be used

# first, the command hammerkit will run, by hand, without HOME and without your shell's other variables:
env -i PATH="$PATH" OP_CONFIG_DIR="$PLAYGROUND_OP_CONFIG" OP_SERVICE_ACCOUNT_TOKEN="$OP_TEST_TOKEN" \
  op read --no-newline op://hammerkit-demo/playground/password

hk run -l live show
```

## 3. What each task should show

| Task           | Expected                                                                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `show`         | `length: 14` and `value:  ***` (the real value never appears)                                                                                                                                       |
| `encodings`    | base64, hex and plain output all `***`                                                                                                                                                              |
| `other-secret` | `other` reads the vault `hammerkit-demo-other`: `other: ***`                                                                                                                                        |
| `as-other`     | fails naming `op:op://hammerkit-demo/playground/password as other` and the `op` error: `other` has no access to `hammerkit-demo`                                                                    |
| `fail-closed`  | fails with `account nobody, provider op: OP_NOBODY_TOKEN is not set`; `op` is never run, so your own session is not tried                                                                           |
| `missing`      | fails naming the secret, `op:op://hammerkit-demo/does-not-exist/password`, account `test`, and the `op` error for the missing item                                                                  |
| `keyed`        | `hk run keyed`, then `hk explain keyed` is a hit; change the password field and `hk explain keyed` is a miss. Run `hk cache ls` or look in `~/.hammerkit`: only a `sha256:` digest, never the value |
| `container`    | needs Docker; the value reaches the container as env and as a read-only file, masked in the log                                                                                                     |

Also check: `hk ls` and `hk validate` work with no tokens set (planning never fetches).

## 4. CI

The `test:docker` task of the repository build file runs the spec. Set these secrets on the GitHub repository:

- `OP_TEST_TOKEN`: the token of `hammerkit-demo-reader`
- `OP_OTHER_TOKEN`: the token of `hammerkit-demo-other`

The workflow installs `op` from 1Password's apt repository, writes both tokens to owner-only files under the
runner's temp directory and passes their paths as `OP_TEST_TOKEN_FILE` and `OP_OTHER_TOKEN_FILE`; the tokens
themselves never go into the environment of the build. Run the spec yourself with the files of section 1:

```sh
OP_TEST_TOKEN_FILE=$PWD/reader.token OP_OTHER_TOKEN_FILE=$PWD/other.token \
  npx vitest run --mode integration src/testing/integration/secrets-1password.spec.ts
```

Without those variables it does nothing locally, and fails when `HAMMERKIT_FULL_INTEGRATION` is set, as in CI.
