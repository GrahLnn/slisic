# Paste Import Behavior

## Behavior Object

`PasteImport` turns one pasted HTTP(S) URL into visible candidate evidence, a
prepared collection shell, and a background download task. It is not a download
worker, player, loudness analyzer, or title fallback generator.

The public seam is:

```text
ClipboardText
  -> UrlResolution
  -> RootTitleEvidence | PreparedCollectionShell | DownloadTaskEvidence | ExistingCollectionEvidence
  -> CandidateProjection
```

The minimal successful path for a new URL is:

```text
normalize(url)
  -> probe_title(url) + prepare_shell(url) + enqueue_task(url)
  -> reflect_title + reflect_task
```

`probe_title/prepare_shell` and `enqueue_task` are sibling effects. Neither
waits for the other. Full playlist expansion and audio/loudness work happen
after the task is accepted and cannot block title feedback.

## Owners

| Owner | Role | Does not own |
| --- | --- | --- |
| `pasteDownload/core` | candidate state, candidate-local evidence reflection | provider IO, collection persistence, UI layout |
| `pasteDownload/machine` | candidate effect composition and async result ownership | title semantics, download execution, draft commit semantics |
| `ListConfig.view-model` | projection of candidates into labels and loading affordance | download task lifecycle, title probing, DB truth |
| `downloads::service` | task enqueue, task execution, root title evidence command | frontend interaction state |
| `downloads::yt_dlp` | provider probes and downloads | persistence, UI candidate lifecycle |
| `collection_import` | prepared collection shell/materialization persistence | clipboard interaction or title-first UX |

## Invariants

- A pasted URL may create at most one active candidate per canonical URL.
- Root title evidence may update candidate text only when the same evidence also
  prepares a committable collection shell. The UI must not construct a ghost
  collection ref.
- Root title probing must not expand playlist entries.
- Enqueue must return task evidence quickly and must not wait for title probing
  or full collection planning.
- Title evidence and task evidence may arrive in any order.
- A candidate remains visible until terminal task evidence, existing collection
  commit, explicit delete, reset, or explicit failure.
- Non-terminal task signals may update title text but cannot remove the
  candidate or commit a collection.
- Terminal task signals may load/commit the materialized collection and close the candidate.
- No fallback title such as `YouTube video <id>` is allowed. Provider failure is
  reflected as an error or left for later task evidence; it is never persisted as
  semantic truth.

## Ya-style Composition

`UrlResolution`, `RootTitleEvidence`, and `DownloadTaskEvidence` are separate
morphisms over the same candidate scope:

```text
Resolve : ClipboardText -> Stops<ResolvedUrl | ExistingCollection | InvalidUrl>
ProbeTitle : ResolvedUrl -> Stops<RootTitleEvidence>
PrepareShell : RootTitleEvidence -> Stops<PreparedCollectionShell>
Enqueue : ResolvedUrl -> Stops<DownloadTaskEvidence>
Reflect : Candidate x Evidence -> Candidate
Project : Candidate -> ListConfigToolLabel
```

`Project` is a functor from candidate state to UI affordance. It may preserve
identity and display text, but it cannot synthesize provider evidence or mutate
download tasks.

`ProbeTitle` is an operator over provider IO. It returns title-shaped evidence
plus a prepared collection shell:

```text
{ url, title, source_kind, collection }
```

It does not expand entries, create musics, measure loudness, or invent fallback
titles. `collection` is a shell persisted by `collection_import`, so a draft that
shows a check icon is saveable even while the download task is still resolving.

## Closed Paths

- No fake provisional collection creation during paste.
- No title fallback derived from a video id.
- No `enqueue -> full download plan -> title -> frontend` dependency.
- No ffplayr/loudness dependency in paste title feedback.
- No UI loading lock merely because a background task is preparing after title
  evidence already exists.

## Checkers

- Machine tests cover title-before-enqueue and enqueue-before-title ordering.
- View-model tests cover loading release once title evidence replaces a URL.
- Rust tests cover title probing preparing a collection shell without task
  creation or playlist entry expansion.
