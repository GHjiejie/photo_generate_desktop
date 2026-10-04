'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const project = path.resolve(__dirname, '..');
const { version, build } = require('../package.json');
if (process.platform !== 'darwin' || process.arch !== 'arm64' || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error('This package script requires an Apple Silicon Mac and a numeric release version.');
}
const release = path.resolve(project, build.directories.output);
const output = path.join(release, 'archives', version, 'runtime');
const exists = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
for (const destination of [output, ...['dmg', 'zip'].map(extension => path.join(release, `Portrait-Studio-React-${version}-arm64.${extension}`))]) {
  if (exists(destination)) throw new Error(`Release output already exists; preserve it and select a new version: ${destination}`);
}
execFileSync(path.join(project, 'node_modules', '.bin', 'electron-builder'),
  ['--dir', '--mac', '--arm64', `--config.directories.output=${output}`],
  { cwd: project, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
