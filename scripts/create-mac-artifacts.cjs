const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { version, build } = require('../package.json');

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('This release script targets Apple Silicon macOS.');
}
const output = path.resolve(__dirname,'..',build.directories.output);
let app = path.join(output,'archives',version,'runtime','mac-arm64','Portrait Studio.app');
let dmgOnly = false;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--dmg-only' && !dmgOnly) dmgOnly = true;
  else if (args[index] === '--app' && args[index + 1]) app = path.resolve(args[++index]);
  else throw new Error('Unknown artifact argument');
}
const stem = `Portrait-Studio-React-${version}-arm64`;
const dmg = path.join(output,`${stem}.dmg`);
const zip = path.join(output,`${stem}.zip`);
const exists = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
if (exists(dmg) || (!dmgOnly && exists(zip))) throw new Error('Release artifact already exists; preserve it and select a new version.');
if (!fs.lstatSync(app).isDirectory() || fs.lstatSync(app).isSymbolicLink() || fs.realpathSync(app) !== app) throw new Error('Use a canonical app bundle directory.');
const appVersion = execFileSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',path.join(app,'Contents','Info.plist')],{encoding:'utf8'}).trim();
if (appVersion !== version) throw new Error('App bundle version differs from the current release.');
const staging = fs.mkdtempSync(path.join(os.tmpdir(),'portrait-dmg-'));
try {
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',app],{stdio:'inherit'});
  if (!dmgOnly) execFileSync('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',app,zip],{stdio:'inherit'});
  execFileSync('/usr/bin/ditto',[app,path.join(staging,'Portrait Studio.app')],{stdio:'inherit'});
  fs.symlinkSync('/Applications',path.join(staging,'Applications'));
  execFileSync('/usr/bin/hdiutil',['create','-volname','Portrait Studio','-srcfolder',staging,'-format','UDZO',dmg],{stdio:'inherit'});
  execFileSync('/usr/bin/hdiutil',['verify',dmg],{stdio:'inherit'});
  console.log(`Created ${stem}.dmg${dmgOnly ? '' : ` and ${stem}.zip`} in ${output}`);
} finally { fs.rmSync(staging,{recursive:true,force:true}); }
