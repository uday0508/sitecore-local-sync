# Changelog

## 0.2.1

- **Layout that fits the editor.** With the Explorer or another panel open, *Pick content* sits above a compact *Sync to local* on the left, and *Activity* takes the full height on the right. Progress, the plan and the log stay on screen without scrolling.
- Narrow editors (a split view) get a single scrolling column. Starting a sync scrolls *Activity* into view.
- The top bar shrinks instead of overflowing, and the page is edge to edge (no default webview padding).

## 0.2.0

- **Full-screen DevSync in VS Code.** The extension now opens the same three-column screen as the desktop app in an editor tab, instead of separate sidebar views. It follows your VS Code theme.
- Desktop app and extension now share one host layer (`src/host/handlers.js`), so they behave identically.
- The workspace folder opens as the project automatically.
- **Pull latest from cloud** on a `.yml` and Page Builder links now open the panel and run there, so you see the plan, conflicts and report.
- Closing the DevSync tab during a run cancels it.
- Removed the separate *onConflict* and *maskPersonalData* settings. Both are now chosen in the panel, as in the desktop app.

## 0.1.1

- Expired Sitecore CLI login: a clear message with a **Log in** button that runs `dotnet sitecore cloud login` in a terminal in your project folder. DevSync reconnects automatically when the login finishes.
- "Add cloud environment" explains an expired login instead of showing raw CLI output.
- A rejected automation client ID or secret gets its own clear message.

## 0.1.0

First release of DevSync for VS Code, built on the same engine as the DevSync desktop app (v0.12.0).

- Cloud content tree with checkboxes, sites as roots, children loaded on expand
- Sync view: selection with scope per item, source → target, last-run status
- Sync, Preview plan and Dry run, with a cancellable progress notification
- Every dependency pulled automatically (templates, renderings, datasources, media, parent folders); items your local CM already has with the same ID are skipped
- "Only what changed" delta sync, per language, with cloud-deletion detection
- Same-path/different-ID conflicts: modal choice, or the `devsync.onConflict` setting
- Profiles (save, load, delete), shared with the desktop app
- Right-click a serialized `.yml` → **DevSync: Pull latest from cloud**
- `vscode://` links for the Sitecore Marketplace "Sync this page" handoff, validated and always confirmed
- Run lock: the tree and inputs are locked during a run; closing VS Code cancels it
- Local CM certificate: trusted through the OS store, mkcert's root, or `devsync.localCaCertificate`, never by turning checks off
- Reports in a themed panel, exportable as HTML or CSV
