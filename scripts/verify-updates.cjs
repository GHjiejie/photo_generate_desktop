// Updates are checked against isolated manifests; this script never requests
// installation or changes a running/user-installed application.
const {_electron:electron,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),version=require('../package.json').version;
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'portrait-update-ui-')),profile=path.join(temporary,'profile'),library=path.join(temporary,'library'),source=path.join(temporary,'releases');
fs.mkdirSync(library);fs.mkdirSync(source);fs.mkdirSync(profile);
const executable=process.env.PORTRAIT_STUDIO_EXECUTABLE,kind=process.env.PORTRAIT_STUDIO_VERIFICATION_NAME||'update-ui';
if(!/^[a-zA-Z0-9._-]+$/.test(kind))throw Error('Invalid verification name');
const output=path.join(root,'.verification');fs.mkdirSync(output,{recursive:true});
const manifest=path.join(source,'updates.json'),config=path.join(profile,'update-source.json');
const checks=[],errors=[];let app,page;
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function publish(candidate,extra={}){fs.writeFileSync(manifest,JSON.stringify({version:candidate,notes:'本地更新校验测试 <script>window.__unsafeUpdate=true</script>',packagePath:'candidate.zip',sha256:sha(Buffer.from('expected contents')),platform:'darwin',arch:'arm64',bundleId:'com.jie.portraitstudio',...extra}));}
async function state(){const result=await page.evaluate(()=>window.portraitStudio.getUpdateState());expect(result.ok).toBe(true);return result.data;}
async function pick(directory){await app.evaluate(({dialog},value)=>{dialog.showOpenDialog=async()=>value?{canceled:false,filePaths:[value]}:{canceled:true,filePaths:[]};},directory);await page.locator('#updateChooseSource').click();}
async function check(){await page.locator('#updateCheck').click();await expect.poll(async()=>(await state()).canCheck).toBe(true);}
async function launch(){app=await electron.launch({executablePath:executable||require('electron'),args:executable?[]:[root],env:{...process.env,PORTRAIT_STUDIO_USER_DATA_DIR:profile,PORTRAIT_STUDIO_LIBRARY_DIR:library}});page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await expect(page.locator('#libraryCreate')).toBeEnabled();await page.locator('#appUpdate').click();await expect(page.locator('#updateDialog')).toBeVisible();await expect(page.locator('#updateCurrentVersion')).toHaveText(version);}
(async()=>{try{
  await launch();expect((await state()).status).toBe('unavailable');await expect(page.locator('#updateCheck')).toBeDisabled();await expect(page.locator('#updateStatus')).toContainText('请选择');expect(fs.existsSync(config)).toBe(false);
  await pick(null);expect(fs.existsSync(config)).toBe(false);checks.push('missing local source is explicit; native directory cancellation makes no changes and never declares latest');
  await pick(source);await expect(page.locator('#updateSourceRoot')).toHaveText(fs.realpathSync(source));await expect(page.locator('#updateCheck')).toBeEnabled();expect(JSON.parse(fs.readFileSync(config)).directory).toBe(fs.realpathSync(source));
  await check();await expect(page.locator('#updateStatus')).toContainText('未完成');expect((await state()).reasons.some(x=>x.code==='READ_FAILED')).toBe(true);checks.push('local source persists; missing updates.json reports the actual read failure');
  publish(version);await check();await expect(page.locator('#updateStatus')).toHaveText('此来源没有更高版本');expect((await state()).canInstall).toBe(false);
  publish('1.3.0');await check();await expect(page.locator('#updateStatus')).toHaveText('此来源没有更高版本');await expect(page.locator('#updatePrepare')).toHaveCount(0);checks.push('equal version and downgrade never expose preparation or installation');
  publish('1.4.1',{packagePath:'../candidate.zip'});await check();expect((await state()).reasons.some(x=>x.code==='INVALID_PACKAGE_PATH')).toBe(true);
  publish('1.4.1',{arch:'x64'});await check();expect((await state()).reasons.some(x=>x.code==='ARCH_MISMATCH')).toBe(true);checks.push('escaping paths and processor mismatch are rejected by actual update IPC');
  fs.writeFileSync(path.join(source,'candidate.zip'),'changed untrusted contents');publish('1.4.1');await check();await expect(page.locator('#updateAvailableVersion')).toHaveText('1.4.1');await expect(page.locator('#updateReleaseNotes')).toContainText('<script>');expect(await page.evaluate(()=>window.__unsafeUpdate)).toBeUndefined();await expect(page.locator('#updatePrepare')).toBeVisible();
  await page.screenshot({path:path.join(output,`${kind}-available-1440x920.png`),scale:'css',animations:'disabled'});
  const candidate=await state();const unconfirmed=await page.evaluate(id=>window.portraitStudio.installUpdate({updateId:id}),candidate.updateId);expect(unconfirmed.ok).toBe(false);expect(unconfirmed.error.code).toBe('CONFIRMATION_REQUIRED');
  await page.locator('#updatePrepare').click();await expect(page.locator('#updateStatus')).toContainText('未完成');expect((await state()).reasons.some(x=>x.code==='CHECKSUM_MISMATCH')).toBe(true);await expect(page.locator('#updateInstall')).toHaveCount(0);checks.push('new version and text-only release notes are real; confirmation and failed package checksum prevent installation');
  await page.screenshot({path:path.join(output,`${kind}-checksum-blocked-1440x920.png`),scale:'css',animations:'disabled'});
  await page.locator('#updateClose').click();await expect(page.locator('#updateDialog')).not.toBeVisible();await page.locator('#libraryCreate').click();await expect(page.locator('#portraitEditor')).toBeVisible();await page.locator('#portraitCancel').click();checks.push('closing update dialog restores existing CRUD interactions');
  await app.close();app=null;await launch();await expect(page.locator('#updateSourceRoot')).toHaveText(fs.realpathSync(source));expect((await state()).status).toBe('idle');checks.push('independent process restart retains selected update source and isolated local-library settings');
  expect(errors).toEqual([]);const result={status:'passed',version,kind,executable:executable||require('electron'),temporary,profile,source,checks,errors,installationRequested:false,userApplicationsModified:false};fs.writeFileSync(path.join(output,`${kind}-verification.json`),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{if(app)await app.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
