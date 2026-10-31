# Simple ModelTrace

[![Tests](https://github.com/rogerflowey/simple-modeltrace/actions/workflows/test.yml/badge.svg)](https://github.com/rogerflowey/simple-modeltrace/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Lightweight background model fingerprint verification for Codex. Automatically verifies that your session is actually running on its configured model and alerts you if there is a mismatch.

## Features

- **Automatic & Non-blocking**: Probes in the background on session start/resume without delaying your conversation.
- **Instant Mismatch Warnings**: Alerts you immediately if the responding model differs from what's configured.
- **Zero Pollution & Zero Cost**: Ephemeral threads run 3 quick numerical challenges; active prompts and tokens stay untouched.
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
modeltrace status      # Newest test across sessions
modeltrace history     # View recent runs
```

In Codex, run `!modeltrace status` or `!modeltrace history` to see the same results.

## Findings

Consistent results are saved silently. Warnings appear only for unexpected fingerprints, inconclusive results, failed or interrupted tests, or unreadable history. Routine startup notices are silent when there is no problem to report.

- **`CONSISTENT`**: Fingerprint matches the configured model.
- **`UNEXPECTED FINGERPRINT`**: ⚠️ Closest reference model differs from configured model.
- **`INCONCLUSIVE`**: Model is not present in reference bank or attribution is unavailable.

## License

[MIT](LICENSE). Scoring logic and candidate reference bank vendored from [ModelTrace](https://github.com/xqy2006/ModelTrace) under its [MIT license](plugins/modeltrace-session/vendor/LICENSE.ModelTrace).
