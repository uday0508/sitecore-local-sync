# Changelog

## 0.2.6

- Clones: pushed without their clone link first and linked again after the push, so a clone saved before its source no longer stops the sync or leaves items without language versions. A clone whose source is missing in the cloud is synced as a regular item (reported) instead of being skipped.
- "validate --fix": items whose files it removes are now listed in the report.

## 0.2.5

- "Filesystem integrity validation found errors" no longer stops the sync: DevSync runs "sitecore ser validate --fix" and pushes again; any file SCS still rejects is left out and listed in the report.
- The push retries automatically when the local CM briefly stops answering.
- When a sync does stop, the report shows the actual error line from the Sitecore CLI instead of only "exited with code 1".

## 0.2.4

- Clones whose source item is missing locally no longer stop the push ("The clone source has incorrect value"). DevSync pulls the missing source from the cloud, pushes sources before their clones, and skips clones whose source doesn't exist in the cloud, with a report entry explaining how to fix '__Source Item'.

## 0.2.3

- **Resizable panels.** Drag the separator between *Pick content* and *Sync to local* (and next to *Activity*) to resize. Double-click resets; arrow keys work when a separator has focus (Shift for bigger steps). Sizes are remembered.
- The **Sync to local** button stays pinned at the bottom of its panel when the panel is short.

## 0.2.2

- **Include media** switch: turn it off to sync pages without the media library items they reference (faster for large sites). The report lists how many were left out. Media you select yourself is always synced. Saved with profiles.
- Solutions with many sites get a compact **Site** picker instead of a wall of buttons, so the content tree keeps its height. The current site is highlighted.

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
