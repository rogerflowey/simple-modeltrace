# Simple ModelTrace

[![Tests](https://github.com/rogerflowey/simple-modeltrace/actions/workflows/test.yml/badge.svg)](https://github.com/rogerflowey/simple-modeltrace/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Lightweight background model fingerprint verification for Codex. Automatically verifies that your session is actually running on its configured model and alerts you if there is a mismatch.

## Features

- **Automatic & Non-blocking**: Probes in the background on session start/resume without delaying your conversation.
- **Instant Mismatch Warnings**: Alerts you immediately if the responding model differs from what's configured.
- **Independent Probes**: Ephemeral threads run 3 numerical challenges without changing the active conversation. Probes consume model tokens and may count toward your provider's usage or billing.
- **Token Usage Monitoring**: Track reported input, cached input, output, and reasoning tokens per sample, run, session, and model.
- **Zero Dependencies**: Pure Node.js (>=22) and Python 3 stdlib. Uses existing Codex authentication.

## Quick Start

### 1. Install Plugin
```bash
git clone https://github.com/rogerflowey/simple-modeltrace.git
cd simple-modeltrace
codex plugin marketplace add .
codex plugin add modeltrace-session@simple-modeltrace
```

### 2. (Optional) Install CLI
Links `modeltrace` to `~/.local/bin/modeltrace`:
```bash
npm --prefix plugins/modeltrace-session run install-cli
```

### 3. Trust Hooks & Restart
Open `/hooks` in Codex, trust the **ModelTrace Session** hooks, and restart Codex.

## Usage

### Terminal

```bash
modeltrace status      # Newest test, including its token usage
modeltrace history     # View recent runs and token totals
modeltrace usage       # Aggregate plugin usage, grouped by model/provider
modeltrace usage --all # Include every session, even when running inside Codex
modeltrace usage --session SESSION_ID --json # Structured usage for one session
modeltrace show RUN    # Details, timeline, and per-sample token usage
modeltrace watch       # Follow the newest test's progress and reported token usage
```

In Codex, prefix commands with `!`, for example `!modeltrace usage`. Commands default to the current session inside Codex and all sessions in a standalone terminal. `--all`, `--session ID`, and `--data-dir PATH` select which local records to read. Usage totals cover all recorded tests in that scope, regardless of the history `--limit`.

Usage is captured from Codex's [`thread/tokenUsage/updated` notifications](https://developers.openai.com/codex/app-server/#turn-events) and saved as probes progress, including reported tokens from failed or truncated samples. Repeated cumulative updates replace the previous sample snapshot, so tokens are counted once. Cached input is part of input, and reasoning is part of output; neither is added again to the total. Cache write input is also retained when Codex reports it.

Older records and providers that omit usage show as unavailable. Interrupted samples with reported usage are marked partial; aggregates exclude unreported tokens and show their coverage. These counts describe ModelTrace's own probes, not your active conversation or account-wide quota, and are not a billing estimate. Reading usage never starts a new test.

## Findings

Consistent results are saved silently. Warnings appear only for unexpected fingerprints, inconclusive results, failed or interrupted tests, or unreadable history. Routine startup notices are silent when there is no problem to report.

- **`CONSISTENT`**: Fingerprint matches the configured model.
- **`UNEXPECTED FINGERPRINT`**: ⚠️ Closest reference model differs from configured model.
- **`INCONCLUSIVE`**: Model is not present in reference bank or attribution is unavailable.

## License

[MIT](LICENSE). Scoring logic and candidate reference bank vendored from [ModelTrace](https://github.com/xqy2006/ModelTrace) under its [MIT license](plugins/modeltrace-session/vendor/LICENSE.ModelTrace).
