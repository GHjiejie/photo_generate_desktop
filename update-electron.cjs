const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {UpdateService,UpdateError}=require('./update-service.cjs');
const {LocalUpdateInstaller,registerLaunch,acknowledgeLaunch}=require('./local-update-installer.cjs');
const BUNDLE_ID='com.jie.portraitstudio';

function createUpdateAdapter({app,BrowserWindow,ipcMain,dialog,rendererURL,trustedSender}){
  let service,installer,configurationError=null;
  const plans=new Map();
  const targetAppPath=app.isPackaged?path.resolve(path.dirname(process.execPath),'..','..'):null;
  function broadcast(state){
    for(const window of BrowserWindow.getAllWindows())if(!window.isDestroyed()&&window.webContents.getURL()===rendererURL)window.webContents.send('update-state-changed',state);
  }
  function errorResult(error){
    return {ok:false,error:{code:error?.code||'UPDATE_FAILED',message:error instanceof UpdateError||typeof error?.code==='string'&&error.code.startsWith('UPDATE_')?error.message:'更新操作未完成，请检查版本文档、安装包与系统权限。'}};
  }
  async function discardPlans(){
    for(const plan of plans.values())await installer?.disposePlan(plan.planPath).catch(()=>{});
    plans.clear();
  }
  function register(channel,handler){
    ipcMain.handle(channel,async(event,...args)=>{
      if(!trustedSender(event,rendererURL))return {ok:false,error:{code:'FORBIDDEN',message:'请求来源无效'}};
      try{return {ok:true,data:await handler(event,...args)};}catch(error){return errorResult(error);}
    });
  }
  async function saveSource(directory){
    const userData=app.getPath('userData');await fs.mkdir(userData,{recursive:true});
    const destination=path.join(userData,'update-source.json');
    const existing=await fs.lstat(destination).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
    if(existing&&(!existing.isFile()||existing.isSymbolicLink()))throw new UpdateError('UPDATE_CONFIGURATION_INVALID','更新来源配置不是普通文件。');
    const temporary=path.join(userData,`.update-source-${randomUUID()}.json`),handle=await fs.open(temporary,'wx',0o600);
    try{await handle.writeFile(JSON.stringify({version:1,directory})+'\n');await handle.sync();}finally{await handle.close();}
    try{await fs.rename(temporary,destination);}catch(error){await fs.unlink(temporary).catch(()=>{});throw error;}
  }
  async function initialise(){
    if(targetAppPath)installer=new LocalUpdateInstaller({targetAppPath,currentVersion:app.getVersion(),bundleId:BUNDLE_ID,arch:process.arch});
    service=new UpdateService({currentVersion:app.getVersion(),platform:process.platform,arch:process.arch,bundleId:BUNDLE_ID,onState:broadcast,
      verifyPackage:async({packagePath,expected,updateId,signal})=>{
        if(!installer)throw new UpdateError('UPDATE_DEVELOPMENT_MODE','源码运行可检查版本；应用替换需从安装版启动。');
        await discardPlans();
        const prepared=await installer.prepare({zipPath:packagePath,sha256:expected.sha256,targetVersion:expected.version,currentVersion:app.getVersion(),bundleId:BUNDLE_ID,arch:process.arch});
        if(signal.aborted){await installer.disposePlan(prepared.planPath);throw new UpdateError('TIMEOUT');}
        plans.set(updateId,prepared);
        return {verified:prepared.verified===true,canInstall:prepared.canInstall===true,reasons:prepared.reasons||[]};
      },
      installPackage:async({updateId,signal})=>{
        const plan=plans.get(updateId);if(!plan?.canInstall)throw new UpdateError('UPDATE_NOT_READY','更新包尚未通过可安装检查，请重新准备。');
        if(signal.aborted)throw new UpdateError('TIMEOUT');
        const result=await installer.handoff({planPath:plan.planPath,parentPid:process.pid,confirmed:true,signal});
        if(signal.aborted||result?.started!==true)throw new UpdateError('TIMEOUT');
        setImmediate(()=>{if(!signal.aborted&&result.started)app.quit();});return {status:'installing'};
      }});
    try{
      const file=path.join(app.getPath('userData'),'update-source.json');
      const stat=await fs.lstat(file).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
      if(stat){
        if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw new UpdateError('UPDATE_CONFIGURATION_INVALID','保存的更新来源配置无效。');
        const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));let bytes;
        try{
          const before=await handle.stat();
          if(!before.isFile()||before.size>16384||before.dev!==stat.dev||before.ino!==stat.ino)throw new UpdateError('UPDATE_CONFIGURATION_INVALID','保存的更新来源配置发生变化。');
          bytes=Buffer.alloc(before.size);let offset=0;
          while(offset<bytes.length){const result=await handle.read(bytes,offset,bytes.length-offset,null);if(!result.bytesRead)throw new UpdateError('UPDATE_CONFIGURATION_INVALID','保存的更新来源配置读取不完整。');offset+=result.bytesRead;}
          const extra=await handle.read(Buffer.alloc(1),0,1,null),after=await handle.stat(),current=await fs.lstat(file);
          if(extra.bytesRead||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||current.isSymbolicLink()||current.dev!==before.dev||current.ino!==before.ino)throw new UpdateError('UPDATE_CONFIGURATION_INVALID','保存的更新来源配置发生变化。');
        }finally{await handle.close();}
        const saved=JSON.parse(bytes.toString('utf8'));
        if(saved.version!==1||typeof saved.directory!=='string'||!path.isAbsolute(saved.directory))throw new UpdateError('UPDATE_CONFIGURATION_INVALID','保存的更新来源配置无效。');
        await service.configureLocalSource(saved.directory);
      }
    }catch(error){configurationError=error;}
    register('update-state',()=>service.getStatus());
    register('update-check',async()=>{
      if(configurationError)throw configurationError;
      if(['checking','downloading','installing'].includes(service.getStatus().status))throw new UpdateError('UPDATE_BUSY','正在处理更新，请稍后检查。');
      await discardPlans();return service.check();
    });
    register('update-source-choose',async event=>{
      const state=service.getStatus();if(['checking','downloading','installing'].includes(state.status))throw new UpdateError('UPDATE_BUSY','正在处理更新，请稍后选择来源。');
      const result=await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender),{title:'选择含 updates.json 的本地发布目录',properties:['openDirectory']});
      if(result.canceled||result.filePaths.length!==1)return {cancelled:true};
      await discardPlans();const next=await service.configureLocalSource(result.filePaths[0]);
      await saveSource(next.sourceRoot);configurationError=null;return next;
    });
    register('update-prepare',(_event,value)=>service.downloadAndStage(value));
    register('update-install',(_event,value)=>service.restartAndInstall(value));
  }
  async function confirmLaunch(){
    if(targetAppPath)await acknowledgeLaunch({argv:process.argv,appPath:targetAppPath,version:app.getVersion()});
  }
  async function registerStartup(){
    if(targetAppPath)await registerLaunch({argv:process.argv,appPath:targetAppPath,version:app.getVersion()});
  }
  return {initialise,confirmLaunch,registerStartup};
}
module.exports={createUpdateAdapter};
