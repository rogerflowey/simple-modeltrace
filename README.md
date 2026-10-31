# Simple ModelTrace

A Codex plugin that runs one background ModelTrace fingerprint test whenever a main
session starts, resumes, clears, or is explicitly forked. Context compaction and
subagent starts do not launch tests. Three independent numerical challenges use
the session's configured model, provider, and reasoning effort through the existing
Codex sign-in. Each test consumes three model responses from that account.

A two-line startup notice announces the background test and summarizes the last
saved result, preferring this session and labeling any fallback from another
session. It includes the previous test's timestamp, finding, configured model,
closest reference, and duration (or failure reason). Active and skipped tests
are excluded; a first run says there is no previous result.

The test itself uses native `async: true`, so work can continue while it runs.
A brief **FINISHED** or **FAILED** report arrives at the next safe conversation
boundary. If the conversation is idle, Codex delivers it on the next user turn;
hooks cannot update the earlier startup message in place. Local commands
show progress immediately, without asking the agent to retrieve results. There
are no periodic probes, tool guards, task pauses, MCP tools, or dashboard services.

The test sends challenges in clean ephemeral conversations rather than copying
the task's context. It checks the configured model/provider, not a particular
response in the main task. ModelTrace reports closed-set probabilities among its
18 bundled candidates; unseen models can resemble existing candidates. In
particular, the pinned bank does not include `gpt-6.1-sol`. Its identity remains
unverified even when a known candidate receives a high score.

## Install

Requires Codex with asynchronous plugin hooks (tested with Codex CLI 0.166.0),
Node.js 22+, and Python 3. Uses no npm or pip packages and does not read or copy
API credentials. The launcher targets Linux, macOS, or WSL with a Unix shell.

Clone the repository using a GitHub account that has access to this private repo,
then register the checkout as a marketplace:

If an older copy is enabled from another marketplace, disable it in `/plugins`
first to avoid running both sets of session hooks.

```sh
git clone https://github.com/rogerflowey/simple-modeltrace.git
cd simple-modeltrace
codex plugin marketplace add .
codex plugin add modeltrace-session@simple-modeltrace
npm --prefix plugins/modeltrace-session run install-cli
```

The repository and marketplace are named `simple-modeltrace`. The plugin keeps
the name `modeltrace-session`, and its shell command is `modeltrace`.

The launcher is installed at `~/.local/bin/modeltrace`, linked to this checkout.
That directory must be on your shell's `PATH`. The install script refuses to
overwrite a different existing command. An optional directory can be supplied
with `node scripts/install-cli.mjs /path/to/bin`.

Open `/hooks` in Codex and review and trust both **ModelTrace Session**
`SessionStart` handlers: the short startup notice and the background test. Codex
deliberately skips untrusted hooks. Restart Codex after installing or updating
the plugin, then review changed hooks and start or resume a session.

See the [official OpenAI plugin packaging documentation](https://developers.openai.com/plugins/build/plugins)
for marketplace details.

## Results

From the Codex composer, run local commands using `!`:

```text
!modeltrace status
!modeltrace history
!modeltrace watch
!modeltrace history --all --limit 20
!modeltrace show 99bb365c
```

`status` shows the newest test for the current `CODEX_THREAD_ID`, including an
active or failed test. It never substitutes a result from another session.
`history` lists tests with start time, duration, execution status, finding,
configured model, and closest reference. `show` accepts a full run ID or the
short ID shown in history and includes the event timeline. `watch` follows
progress until the newest test finishes; press Ctrl+C to stop watching. Captured
shell output prints state changes; a standalone terminal also refreshes elapsed
time every two seconds. Watching does not launch tests.

Outside Codex, run the same commands without `!`; all sessions are included when
`CODEX_THREAD_ID` is absent. Use `--session ID` to select a session, or `--all` to
override the current one. `--json` includes structured records and raw samples.
These commands read local files and never call a model. The old entry point
`node scripts/session-start.mjs status` also works.

Example startup notice:

```text
ModelTrace · testing in background · !modeltrace status
Last (this session, 2026-10-31 18:42:50 +08:00): FINISHED · INCONCLUSIVE · configured gpt-6.1-sol · closest reference gpt-6-astra · 2m 47s
```

Example completion notice:

```text
ModelTrace — FINISHED · INCONCLUSIVE · configured gpt-6.1-sol · closest reference gpt-6-astra · 2m 47s
Reason: Configured model is absent from the reference bank; exact identity is unverified.
Details: !modeltrace status · History: !modeltrace history
```

The full report remains available through `!modeltrace status`:

```text
ModelTrace — COMPLETED · INCONCLUSIVE
Started: 2026-10-31 18:40:03 +08:00
Finished: 2026-10-31 18:42:50 +08:00 · Duration: 2m 47s
Configured: gpt-6.1-sol · openai · xhigh
Samples: 3/3 valid
Closest reference: gpt-6-astra
Reason: Configured model is absent from the reference bank; exact identity is unverified.
```

Execution status and the fingerprint finding are separate. A completed test can
be **consistent**, have an **unexpected fingerprint**, or be **inconclusive**
because reference coverage is missing. Candidate percentages are weights within
the closed reference bank, not a probability that the provider substituted a
model. An unexpected reference is a statistical signal, not proof of substitution.

New runs save settings and partial samples as they progress through reading
settings, preparing challenges, samples 1–3, and analysis. Failures identify the
stage and retain valid samples. Dead workers appear as **INTERRUPTED**. Linux
PID namespace and process start identity prevent false reports caused by PID
reuse or a hook running outside the shell's process namespace. When the worker
cannot be inspected, unfinished runs are considered interrupted after the
ten-minute hook deadline. The exact stop time and duration remain unknown;
reading history does not rewrite old files.

Results use private file permissions under `PLUGIN_DATA` when supplied by Codex,
otherwise `~/.codex/modeltrace-session/` (respecting `CODEX_HOME`). The CLI
automatically discovers both `~/.codex/plugins/data/modeltrace-session-*` and
the legacy location, deduplicates `latest.json`, and preserves existing history.
`--data-dir PATH`, `MODELTRACE_DATA_DIR`, or `PLUGIN_DATA` explicitly select one
directory. Each run gets its own JSON file; `latest.json` remains a compatibility
copy of the latest finished result. A process lock prevents overlapping tests
of the same thread; a later resume runs a fresh test.

Codex currently has no documented plugin API for custom footer items, extra
`/status` rows, or native local slash-command handlers. The `!modeltrace` commands
are local shell commands, not an agent skill or a custom `/modeltrace` command.
Hook reports use only `systemMessage`; they add no explicit `additionalContext`.

## Development

```sh
npm test
```

Run tests from the repository root. They use local fixtures and the real bundled
scorer; they do not make model calls or require a Codex sign-in. GitHub Actions
runs the suite on Node.js 22 and 24 with Python 3.

After edits, rerun `codex plugin add modeltrace-session@simple-modeltrace` to refresh
the installed copy. Restart Codex and review changed hook definitions in `/hooks`
again when required. The CLI symlink uses this checkout, so editing its scripts
does not require reinstalling the launcher.

The unmodified scorer, reference bank, and standalone challenge generator are
vendored from [xqy2006/ModelTrace](https://github.com/xqy2006/ModelTrace), pinned to
commit `6cd4a8ff0f3f4e49d6d6969dd2fbadfa1569fde2` under its MIT license.
`vendor/provenance.json` records checksums. The original ModelTrace Guard runtime
is not used.

The upstream MIT license is preserved at
[`plugins/modeltrace-session/vendor/LICENSE.ModelTrace`](plugins/modeltrace-session/vendor/LICENSE.ModelTrace).
