# 0012: A published build file is named by its hash only

[ADR-0010](0010-a-server-run-is-derived-pinned-and-isolated.md) pins a run to the hash of a published build file. The first implementation also gave every build file a name of the publisher's choice (`PUT /v1/definitions/<name>`), with `latest`, a proposal that follows the latest version of its name (`stale` otherwise) and `remote diff` against it. The name protected nothing: whoever may publish or propose picks any name, so a new name starts a new line and a diff against "the previous version" shows what the proposer chose to compare with, not what changed.

- **A version is its hash, and nothing else names it.** `POST /v1/definitions` publishes or proposes a bundle and answers its hash; runs, proposals, yank and unyank name the hash. There is no `latest`: a run names exactly what it runs.
- **Whoever decides reads the whole version.** A proposal shows its plan and its files (`remote show <hash>`), never a diff. The proposal no longer records a base, so `stale` goes.
- **Yank stays.** Every published hash stays runnable until it is yanked, so it is the only way to stop a version; `unyank` stays too, because the same files always have the same hash and can not be published anew.
- **A rejection's cooldown is per proposer and per version.** Without names, the proposer may not propose anything for the cooldown, and nobody that version.

## Considered options

- **Keep names and protect them** (an owner per name, or names listed in the server config) — rejected: it adds config and ownership rules to make a diff meaningful, while a reviewer still has to read the plan and the accounts of the version.
- **Derive a grouping from the repository and entry path** — not now: nothing needs a grouping yet. Listing shows every version with who published it, when, its tasks and accounts.

## Consequences

- The API and CLI change: `remote publish [server]` takes no name, `remote diff` is gone, and `name@hash` becomes `sha256:...`. The server is experimental.
- Versions a server stored under a name (`definitions/<name>/<hex>.json`) are read as versions; one published under two names counts once, and stays yanked if either copy was. Stored runs keep the hash of their build file.
