# Secret providers playground (Google Secret Manager)

Tries the secret providers against a real Secret Manager. It uses local tasks, so it needs
`gcloud` and Node, no Docker (only the optional `container` task does).

CI runs it too: [secrets-gsm.spec.ts](../../src/testing/integration/secrets-gsm.spec.ts) copies this folder and
checks every row of the table in section 3 against the demo project of section 1. It fails, it does not skip,
when the credentials below are missing. See [CI](#4-ci) for what to set.

## 1. A demo project (one time, about 10 minutes)

Use a project of its own, with nothing else in it. Replace `PROJECT` and `BILLING_ACCOUNT`.

```sh
PROJECT=hammerkit-secrets-demo
gcloud projects create $PROJECT
gcloud billing projects link $PROJECT --billing-account=BILLING_ACCOUNT   # Secret Manager needs billing, the free tier covers this
gcloud services enable secretmanager.googleapis.com --project=$PROJECT

# two secrets
printf '%s' 'demo-value-one' | gcloud secrets create hammerkit-playground       --data-file=- --project=$PROJECT
printf '%s' 'other-value'    | gcloud secrets create hammerkit-playground-other --data-file=- --project=$PROJECT

# two service accounts: the reader gets one secret, "other" gets the other one
for sa in hammerkit-demo-reader hammerkit-demo-other; do
  gcloud iam service-accounts create $sa --project=$PROJECT
done
gcloud secrets add-iam-policy-binding hammerkit-playground \
  --member=serviceAccount:hammerkit-demo-reader@$PROJECT.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor --project=$PROJECT
gcloud secrets add-iam-policy-binding hammerkit-playground-other \
  --member=serviceAccount:hammerkit-demo-other@$PROJECT.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor --project=$PROJECT

# a key file for each (needs the org policy iam.disableServiceAccountKeyCreation off for this project)
gcloud iam service-accounts keys create reader.json --iam-account=hammerkit-demo-reader@$PROJECT.iam.gserviceaccount.com
gcloud iam service-accounts keys create other.json  --iam-account=hammerkit-demo-other@$PROJECT.iam.gserviceaccount.com
```

Neither service account has any role on the project itself, only `secretAccessor` on its own
secret. Delete the keys (and the project) when you are done.

## 2. Run it yourself

```sh
npm ci && npm run build     # in the hammerkit checkout
cd examples/secrets-gsm     # the folder with .hammerkit.yaml; elsewhere hk only offers init and help
alias hk='node /path/to/hammerkit/dist/index.js'

export GCP_PROJECT=hammerkit-secrets-demo
export GSM_TEST_CREDENTIALS=$PWD/reader.json
export GSM_OTHER_CREDENTIALS=$PWD/other.json
export PLAYGROUND_GCLOUD_CONFIG=$(mktemp -d)     # empty gcloud config: no personal login can be used

# first, the command hammerkit will run, by hand, without HOME and without your shell's other variables:
env -i PATH="$PATH" CLOUDSDK_CONFIG="$PLAYGROUND_GCLOUD_CONFIG" CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE="$GSM_TEST_CREDENTIALS" \
  gcloud secrets versions access latest --secret=hammerkit-playground --project="$GCP_PROJECT"

hk run -l live show
```

## Troubleshooting: `hk` only lists `init` and `help`

hammerkit only registers `ls`, `run`, `validate` and the rest when it finds a `.hammerkit.yaml` in the current folder. Elsewhere (for example `~/Downloads`) you get just `init` and `help`, and `unknown command 'run'`. Copy `.hammerkit.yaml` and `playground.txt` into a folder of your own, `cd` there and run `hk ls`.
From another folder, `hk --file <relative/path>/.hammerkit.yaml run -l live show` also works (the path is relative to the current folder).

## 3. What each task should show

| Task           | Expected                                                                                                                                                                                                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `show`         | `length: 14` and `value:  ***` (the real value never appears)                                                                                                                                                                                                                                 |
| `encodings`    | base64, hex and plain output all `***`                                                                                                                                                                                                                                                        |
| `other-secret` | `other` reads `hammerkit-playground-other`: `other: ***`                                                                                                                                                                                                                                      |
| `as-other`     | fails with a permission error: `other` may not read `hammerkit-playground` (grant it to see it pass)                                                                                                                                                                                          |
| `fail-closed`  | fails with `account nobody, provider gsm: GSM_NOBODY_CREDENTIALS is not set`; `gcloud` is never run, so your own login is not tried                                                                                                                                                           |
| `missing`      | fails naming the secret, `gsm:hammerkit-playground-does-not-exist`, account `test`, and gcloud's NOT_FOUND                                                                                                                                                                                    |
| `keyed`        | `hk run keyed`, then `hk explain keyed` is a hit; add a version (`printf x \| gcloud secrets versions add hammerkit-playground --data-file=- --project=$GCP_PROJECT`) and `hk explain keyed` is a miss. Run `hk cache ls` or look in `~/.hammerkit`: only a `sha256:` digest, never the value |
| `container`    | needs Docker; the value reaches the container as env and as a read-only file, masked in the log                                                                                                                                                                                               |

Also check: `hk ls` and `hk validate` work with no credentials set (planning never fetches),
and `hk --verbose run show` logs `secret hammerkit-playground via gsm/test` once per fetch.

## 4. CI

The `test:docker` task of the repository build file runs the spec. Set on the GitHub repository:

- variable `GCP_PROJECT` (or a secret of that name): the demo project id
- secret `GSM_TEST_CREDENTIALS_JSON`: the contents of `reader.json`
- secret `GSM_OTHER_CREDENTIALS_JSON`: the contents of `other.json`

The workflow writes both keys to owner-only files under the runner's temp directory and passes their paths as
`GSM_TEST_CREDENTIALS` and `GSM_OTHER_CREDENTIALS`. Run the spec yourself with the exports of section 2 and
`npx vitest run --mode integration src/testing/integration/secrets-gsm.spec.ts`. Without those variables it does
nothing locally, and fails when `HAMMERKIT_FULL_INTEGRATION` is set, as in CI.
