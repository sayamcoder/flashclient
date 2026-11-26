/* Builds a Debian installer for Linux and prints GitHub Release upload details.

   npm run release:linux
     -> builds the x64 .deb installer into release-linux-installer/
*/

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import tar from 'tar-stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// A virus scanner can hold linux-unpacked/resources/app.asar open right after a
// build; RELEASE_OUT lets that run happen somewhere else.
const output = process.env.RELEASE_OUT
  ? path.resolve(process.env.RELEASE_OUT)
  : path.join(root, 'release-linux-installer');

const config = JSON.parse(fs.readFileSync(path.join(root, 'src', 'update-feed.json'), 'utf8'));
const repo = String(config.github || '')
  .trim()
  .replace(/^https?:\/\/github\.com\//i, '')
  .replace(/\.git$/i, '');
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.error('src/update-feed.json needs "github": "owner/repo".');
  process.exit(1);
}

const builderCli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
if (!fs.existsSync(builderCli)) {
  console.error('electron-builder is not installed. Run npm install first.');
  process.exit(1);
}

console.log(`Building Flash Client ${pkg.version} Linux installer…`);
fs.mkdirSync(output, { recursive: true });
// Build the Linux app directory; electron-builder's .deb target requires fpm.
const build = spawnSync(
  process.execPath,
  [builderCli, '--dir', '--linux', '--x64', `--config.directories.output=${output}`],
  { cwd: root, stdio: 'inherit' }
);
if (build.error) {
  console.error(`\nCould not start electron-builder: ${build.error.message}`);
  process.exit(1);
}
if (build.status !== 0) {
  console.error('\nLinux installer build failed.');
  process.exit(build.status || 1);
}

const appDir = path.join(output, 'linux-unpacked');
if (!fs.existsSync(path.join(appDir, 'flash-client'))) {
  console.error(`Linux app files were not produced in ${path.relative(root, appDir)}.`);
  process.exit(1);
}

const installerName = `${pkg.name}_${pkg.version}_amd64.deb`;
const installer = path.join(output, installerName);
const temporaryInstaller = `${installer}.tmp`;
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-client-deb-'));
const desktopPath = path.join(temporaryDirectory, 'flash-client.desktop');
const controlPath = path.join(temporaryDirectory, 'control');
const dataTarPath = path.join(temporaryDirectory, 'data.tar.gz');
const controlTarPath = path.join(temporaryDirectory, 'control.tar.gz');

async function addEntry(archive, header, sourcePath) {
  await new Promise((resolve, reject) => {
    const entry = archive.entry(header, (error) => error ? reject(error) : resolve());
    if (!sourcePath) {
      entry.end();
      return;
    }

    const source = fs.createReadStream(sourcePath);
    source.once('error', (error) => {
      entry.destroy(error);
      reject(error);
    });
    source.pipe(entry);
  });
}

async function writeTarGz(filePath, entries) {
  const archive = tar.pack();
  const completed = pipeline(archive, createGzip({ level: 9 }), fs.createWriteStream(filePath));
  for (const entry of entries) {
    await addEntry(archive, entry.header, entry.sourcePath);
  }
  archive.finalize();
  await completed;
}

function applicationEntries(directory, archivePath) {
  const entries = [{
    header: { name: archivePath, type: 'directory', mode: 0o755 }
  }];
  for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const sourcePath = path.join(directory, item.name);
    const entryPath = `${archivePath}/${item.name}`;
    const stat = fs.lstatSync(sourcePath);
    if (item.isDirectory()) {
      entries.push(...applicationEntries(sourcePath, entryPath));
    } else if (item.isSymbolicLink()) {
      entries.push({
        header: {
          name: entryPath,
          type: 'symlink',
          linkname: fs.readlinkSync(sourcePath),
          mode: 0o777
        }
      });
    } else if (item.isFile()) {
      const executable = ['flash-client', 'chrome_crashpad_handler'].includes(item.name);
      const sandbox = item.name === 'chrome-sandbox';
      entries.push({
        header: {
          name: entryPath,
          size: stat.size,
          mode: sandbox ? 0o4755 : executable ? 0o755 : 0o644
        },
        sourcePath
      });
    }
  }
  return entries;
}

function writeArHeader(stream, name, size) {
  const fields = [
    `${name}/`.padEnd(16),
    '0'.padEnd(12),
    '0'.padEnd(6),
    '0'.padEnd(6),
    '100644'.padEnd(8),
    String(size).padEnd(10),
    '`\n'
  ];
  const header = Buffer.from(fields.join(''), 'ascii');
  if (header.length !== 60) {
    throw new Error(`Invalid ar header length for ${name}.`);
  }
  stream.write(header);
}

async function writeArArchive(filePath, members) {
  const stream = fs.createWriteStream(filePath);
  const streamError = new Promise((_, reject) => stream.once('error', reject));
  stream.write('!<arch>\n');

  for (const member of members) {
    const size = fs.statSync(member.filePath).size;
    writeArHeader(stream, member.name, size);
    for await (const chunk of fs.createReadStream(member.filePath)) {
      if (!stream.write(chunk)) {
        await Promise.race([
          new Promise((resolve) => stream.once('drain', resolve)),
          streamError
        ]);
      }
    }
    if (size % 2 !== 0) {
      stream.write('\n');
    }
  }

  stream.end();
  await Promise.race([
    new Promise((resolve) => stream.once('close', resolve)),
    streamError
  ]);
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('data', (chunk) => hash.update(chunk));
    input.once('error', reject);
    input.once('end', () => resolve(hash.digest('hex')));
  });
}

try {
  fs.writeFileSync(desktopPath, [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${pkg.productName || 'Flash Client'}`,
    'Exec=/opt/flash-client/flash-client',
    'Icon=flash-client',
    'Terminal=false',
    'Categories=Utility;',
    ''
  ].join('\n'));

  fs.writeFileSync(controlPath, [
    `Package: ${pkg.name}`,
    `Version: ${pkg.version}`,
    'Section: utils',
    'Priority: optional',
    'Architecture: amd64',
    'Maintainer: Flash Client',
    `Depends: ${[
      'libgtk-3-0',
      'libnotify4',
      'libnss3',
      'libxss1',
      'libxtst6',
      'xdg-utils',
      'libatspi2.0-0',
      'libuuid1',
      'libsecret-1-0'
    ].join(', ')}`,
    `Description: ${pkg.description}`,
    ''
  ].join('\n'));

  await writeTarGz(controlTarPath, [{
    header: { name: 'control', size: fs.statSync(controlPath).size, mode: 0o644 },
    sourcePath: controlPath
  }]);

  const dataEntries = [
    { header: { name: 'opt', type: 'directory', mode: 0o755 } },
    ...applicationEntries(appDir, 'opt/flash-client'),
    { header: { name: 'usr', type: 'directory', mode: 0o755 } },
    { header: { name: 'usr/share', type: 'directory', mode: 0o755 } },
    { header: { name: 'usr/share/applications', type: 'directory', mode: 0o755 } },
    {
      header: {
        name: 'usr/share/applications/flash-client.desktop',
        size: fs.statSync(desktopPath).size,
        mode: 0o644
      },
      sourcePath: desktopPath
    },
    { header: { name: 'usr/share/icons', type: 'directory', mode: 0o755 } },
    { header: { name: 'usr/share/icons/hicolor', type: 'directory', mode: 0o755 } },
    { header: { name: 'usr/share/icons/hicolor/512x512', type: 'directory', mode: 0o755 } },
    { header: { name: 'usr/share/icons/hicolor/512x512/apps', type: 'directory', mode: 0o755 } },
    {
      header: {
        name: 'usr/share/icons/hicolor/512x512/apps/flash-client.png',
        size: fs.statSync(path.join(root, 'build', 'icon.png')).size,
        mode: 0o644
      },
      sourcePath: path.join(root, 'build', 'icon.png')
    }
  ];
  await writeTarGz(dataTarPath, dataEntries);

  const debianBinaryPath = path.join(temporaryDirectory, 'debian-binary');
  fs.writeFileSync(debianBinaryPath, '2.0\n');
  await writeArArchive(temporaryInstaller, [
    { name: 'debian-binary', filePath: debianBinaryPath },
    { name: 'control.tar.gz', filePath: controlTarPath },
    { name: 'data.tar.gz', filePath: dataTarPath }
  ]);
  fs.renameSync(temporaryInstaller, installer);

  const size = fs.statSync(installer).size;
  const sha256 = await hashFile(installer);
  const tag = `v${pkg.version}`;
  const asset = installerName;

  console.log(`\nInstaller: ${asset} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`sha256:    ${sha256}`);
  console.log(`
Upload the installer to a GitHub release:
  https://github.com/${repo}/releases/new?tag=${tag}
  Tag: ${tag}
  Attach: ${asset}`);
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  if (fs.existsSync(temporaryInstaller)) {
    fs.rmSync(temporaryInstaller);
  }
}
