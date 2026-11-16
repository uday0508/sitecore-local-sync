# Contributing to DevSync

Thanks for helping make local SitecoreAI development easier. This guide covers how to set up the project, how the code is organised, and what we look for in a pull request.

## Ways to contribute

- **Report a bug.** Open an issue with the steps to reproduce and the run report (see [Reporting bugs](#reporting-bugs)).
- **Suggest a feature.** Open an issue describing the problem first, before the solution. Real project scenarios are the most useful.
- **Improve the docs.** README fixes, troubleshooting entries and screenshots are always welcome.
- **Send code.** Pick an open issue, or open one first for anything larger than a small fix, so we can agree on the approach.

## Development setup

Requirements:

- Node.js 18 or later (20+ recommended)
- Git
- For real syncs only: the .NET SDK, a SitecoreAI project with the Sitecore CLI, and a running local Docker CM

```bash
git clone https://github.com/uday0508/sitecore-local-sync.git
cd sitecore-local-sync
npm install
npm start      # desktop app
npm test       # engine tests
```

You don't need a Sitecore environment to work on most of the code. Without a project, the app opens in **demo mode** with sample content, and the test suite uses simulators instead of the real CLI and APIs.

Useful environment variables:

| Variable | Purpose |
|---|---|
| `DEVSYNC_HOME` | Data folder (workspaces, reports, manifests). Point it at a temp folder while testing. |
| `DEVSYNC_DOTNET` | Path to the `dotnet` executable, or to a fake one. |
| `DEVSYNC_API_TIMEOUT_MS` | Authoring API request timeout (default 60000). |
| `DEVSYNC_CLI_IDLE_MS` | Stop a CLI command that prints nothing for this long (default 600000). |

## Project layout

```text
src/core/       sync engine, plain Node.js (no Electron imports)
src/main/       Electron main process and preload (IPC)
src/renderer/   UI, vanilla JavaScript, strict CSP
bin/devsync.js  headless CLI
test/           node:test suites, fake-scs.js (SCS simulator), ui-smoke.js
docs/           screenshots used in the README
```

`src/core` is shared by the desktop app, the headless CLI and the tests. Keep it free of Electron so it can also back future front-ends (a VS Code extension, a Marketplace app).

## Ground rules for changes

These protect users' environments. Pull requests that break them won't be merged.

1. **Read-only against the cloud.** Never send a mutation to a cloud environment, and never push to a non-local target. The guards in `graphql.js` and `workspace.js` (`assertSafeTargets`) must stay in place.
2. **Never silently overwrite or delete local work.** Templates, renderings and parent folders are `CreateOnly`. Anything removed locally goes to the Recycle Bin, by item ID, and only after the user agrees or the item was synced by DevSync.
3. **Nothing in the user's repository.** Workspaces, backups, manifests and reports belong in the data folder (`src/core/paths.js`), not in the project folder.
4. **Every network call and child process can time out and be cancelled.** Pass the run's `AbortSignal` through, use the client's timeout, and spawn the CLI with `runCli()` so the process tree can be killed.
5. **Keep the UI simple.** Prefer sensible defaults over new options. If a new setting seems necessary, explain why in the issue first.
6. **Report, don't hide.** Anything skipped, replaced or deleted must appear in the run report with a clear `fix` for the user.

## Tests

```bash
npm test                                              # all engine tests
node --test test/conflicts.test.js                    # one suite
xvfb-run -a npx electron --no-sandbox test/ui-smoke.js   # UI smoke test (Linux)
```

- **Every bug fix needs a regression test** that fails without the fix.
- Use the fakes in `test/helpers.js`. They provide a fake Authoring client, a temporary project and an SCS simulator (`test/fake-scs.js`). The simulator behaves like the real CLI: `allowWrite`, scopes, `Ignored` rules, path/ID collisions, template order, parents and token rotation.
- If your change depends on a Sitecore behaviour the simulator doesn't model yet, extend the simulator in the same pull request.
- The UI smoke test writes screenshots to `build/screenshots/`. Update `docs/screenshots/` if your change affects the UI shown in the README.

## Code style

- Plain JavaScript (CommonJS), `'use strict'`, no build step.
- No new runtime dependencies without discussion. The app currently has none.
- Small functions, clear names, and comments that explain *why* rather than *what*.
- User-facing messages are plain English, say what happened and what to do next, and avoid internal terms.
- No inline styles or inline scripts in the renderer (the CSP blocks them).

## Pull requests

1. Fork the repo and create a branch from `main` (`fix/delta-language-filter`, `feat/vscode-extension`).
2. Keep each pull request focused on one change.
3. Run `npm test` and make sure everything passes.
4. Update the README (features, troubleshooting or limitations) if behaviour changes.
5. In the description, explain the problem, the fix, and how you tested it. For sync behaviour, say whether you tested against a real environment, the simulator, or both.

Commit messages: a short imperative summary (`Fix delta search when the index rejects _language`), with details in the body if needed.

## Reporting bugs

Please include:

- DevSync version (shown in `package.json`) and your OS
- Sitecore CLI version (`dotnet sitecore --version`)
- What you selected, and whether it was a full or "only what changed" sync
- The run report (**Report** tab, then **Save report…**) and the relevant part of the **Log** tab

**Before you post anything, remove secrets.** Never paste `.sitecore/user.json`, access or refresh tokens, client secrets, or content you aren't allowed to share. Replace host names and item paths if they identify a client.

## Security

If you find a security issue, such as a way to write to a cloud environment or to leak tokens, please don't open a public issue. Contact the maintainer privately through the GitHub profile and give us time to fix it before disclosure.

## License

DevSync is licensed under [Apache-2.0](LICENSE). By contributing, you agree that your contributions are licensed under the same terms.
