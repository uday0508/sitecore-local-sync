'use strict';
// Bundles the extension and the shared DevSync engine + host (../src) into dist/extension.js, and
// copies the desktop UI (../src/renderer) plus the webview bridge into dist/ui.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

function copyUi() {
  const out = path.join(__dirname, 'dist', 'ui');
  fs.mkdirSync(out, { recursive: true });
  const renderer = path.join(__dirname, '..', 'src', 'renderer');
  for (const f of ['index.html', 'app.js', 'styles.css']) fs.copyFileSync(path.join(renderer, f), path.join(out, f));
  for (const f of ['bridge.js', 'vscode-theme.css']) fs.copyFileSync(path.join(__dirname, 'webview', f), path.join(out, f));
  fs.copyFileSync(path.join(__dirname, 'media', 'icon.png'), path.join(out, 'icon.png'));
}

const options = {
  entryPoints: ['src/extension.js'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

(async () => {
  copyUi();
  if (watch) { const ctx = await esbuild.context(options); await ctx.watch(); }
  else await esbuild.build(options);
})().catch((e) => { console.error(e); process.exit(1); });
