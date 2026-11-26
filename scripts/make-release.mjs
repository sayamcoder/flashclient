/* Packages the launcher for GitHub Releases.

   npm run release
     -> builds the NSIS installer into release-build/
     -> writes release-build/update.json (version, download URL, sha256, size)

   Then create a GitHub release tagged v<version> on the repo named in
   src/update-feed.json and upload both files. The launcher reads
   /releases/latest, so the newest published release is the live update. */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// A virus scanner or indexer can hold win-unpacked/resources/app.asar open for a
// while after a build; RELEASE_OUT lets that run happen somewhere else.
const output = process.env.RELEASE_OUT
  ? path.resolve(process.env.RELEASE_OUT)
  : path.join(root, 'release-build');

const config = JSON.parse(fs.readFileSync(path.join(root, 'src', 'update-feed.json'), 'utf8'));
const repo = String(config.github || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '');
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.error('src/update-feed.json needs "github": "owner/repo" (or upload update.json yourself).');
  process.exit(1);
}

console.log(`Building Flash Client ${pkg.version} …`);
fs.mkdirSync(output, { recursive: true });
const builderCli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
if (!fs.existsSync(builderCli)) {
  console.error('electron-builder is not installed. Run npm install first.');
  process.exit(1);
}

const build = spawnSync(
  process.execPath,
  [builderCli, '--win', 'nsis', `--config.directories.output=${output}`],
  { cwd: root, stdio: 'inherit' }
);
if (build.status !== 0) {
  console.error('\nBuild failed. If winCodeSign hit a symlink privilege error, enable Developer Mode and retry.');
  process.exit(build.status || 1);
}

const installer = fs.readdirSync(output)
  .filter((name) => /setup.*\.exe$/i.test(name))
  .map((name) => path.join(output, name))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];

if (!installer) {
  console.error('No setup .exe was produced in release-build/.');
  process.exit(1);
}

const bytes = fs.readFileSync(installer);
const sha256 = createHash('sha256').update(bytes).digest('hex');
// Releases may use a named tag instead of the version number.
const tag = String(config.tag || '').trim() || `v${pkg.version}`;
const asset = path.basename(installer);
const manifest = {
  version: pkg.version,
  download: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(asset)}`,
  sha256,
  size: bytes.length,
  notes: [],
  publishedAt: new Date().toISOString().slice(0, 10)
};

const manifestPath = path.join(output, 'update.json');
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`\nInstaller: ${asset} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
console.log(`sha256:    ${sha256}`);
console.log(`manifest:  ${path.relative(root, manifestPath)}`);
console.log(`
Upload both files to a GitHub release:
  1. https://github.com/${repo}/releases/new?tag=${tag}
  2. Tag: ${tag}   (the tag must be the version)
  3. Attach ${asset}
  4. Attach update.json (only needed when the release has no sha256 digest)
  5. Publish release — the launcher picks it up on the next check.`);
