# @archon/forge-forgejo

Archon forge plugin for **Forgejo** (including [Codeberg](https://codeberg.org)) and **Gitea** (including [gitea.com](https://gitea.com) and self-hosted instances) speaking the `@archon/forge` protocol version 1.

The plugin talks directly to the Forgejo/Gitea v1 REST API (`/api/v1`) over HTTPS using the token Archon passes via `ARCHON_FORGE_TOKEN`.

## Where this lives

The plugin is published from [`KIntegrated/archon-forge-forgejo`](https://github.com/KIntegrated/archon-forge-forgejo):

```sh
archon plugin add KIntegrated/archon-forge-forgejo
```

That repository is the source of truth from now on; this copy is the fork's development
line and is where behaviour is tried before it is released there. It builds and tests
against a pinned Archon commit recorded in that repository's `archon-contract.json`,
because `@archon/forge` is a workspace package here and is not published to npm.

## Pairing with the bundled Gitea adapter

Archon reaches a Gitea-compatible instance through two independent layers, and this plugin is
only the second one:

- The **bundled Gitea adapter** (`GITEA_URL`, `GITEA_TOKEN`, `GITEA_WEBHOOK_SECRET`) turns an
  issue or pull request comment into a conversation and a run, and posts the reply back. It is
  the chat surface.
- This **forge plugin** answers what a workflow needs to decide something about the item:
  checks and their logs, the pull request's files and views, reviews, the marked comment, labels
  and a qualified merge.

Neither replaces the other; an install that wants both configures both. Both read
`GITEA_TOKEN`, so point the plugin at that variable rather than letting it fall back to a `tea`
login, and the two layers cannot drift into different identities:

```yaml
forge:
  hosts:
    forge.example.org:
      plugin: forgejo
      token_env: GITEA_TOKEN
```

Upstream tracks the remaining gap — one host, two configuration paths, and no statement of how
they relate — as issue #6427.

## Configuration

By default the plugin claims `codeberg.org` and `gitea.com`. Credentials resolve in order:

1. `FORGEJO_TOKEN`, `CODEBERG_TOKEN`, or `GITEA_TOKEN` in `~/.archon/.env` (or `ARCHON_HOME/.env`)
2. Your local `tea` CLI login (`tea logins helper get`) for the target host

```sh
FORGEJO_TOKEN=<your-token>
```

If you are already logged in via `tea login add`, no environment variable is needed. To map an additional self-hosted Forgejo or Gitea instance in `~/.archon/config.yaml`:

```yaml
forge:
  hosts:
    forge.example.org:
      plugin: forgejo
      token_env: FORGE_EXAMPLE_TOKEN
```

## Build

```sh
bun run --cwd packages/forge-forgejo build
```

Copy `packages/forge-forgejo/dist/archon-forge-forgejo` into `~/.archon/plugins/` for release binaries. Source checkouts run the plugin directly from source.

## Capabilities

- `resolve`, `resolve:subject` (`/issues/<n>`, `/pulls/<n>`)
- `pr.view`, `pr.view:any-state`, `pr.create`, `pr.edit-body`, `pr.ready`, `pr.draft`, `pr.merge` (enforces `head` via `head_commit_id`), `pr.merge-state`, `pr.files`, `pr.reviews`, `pr.threads`, `pr.review.submit`
- `workitem.view`, `workitem.create`, `workitem.edit-body`, `workitem.list`, `workitem.search`, `workitem.comments`, `workitem.comment.upsert`, `workitem.labels.set`, `workitem.label.add`, `workitem.label.remove`
- `comment.upsert`
- `repo.labels.list`, `repo.label.ensure`, `repo.file`
- `checks.state`, `checks.commit`, `checks.logs`, `checks.rerun` (supports both Forgejo Actions and Gitea Actions schemas, plus external commit statuses)
- `attachment.put`

`workitem.close`, `pr.thread.reply`, and `pr.thread.resolve` are intentionally omitted because Forgejo/Gitea's REST API does not expose issue close reasons or review-thread reply/resolve endpoints.
