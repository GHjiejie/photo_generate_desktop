const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {LocalLibrary,LibraryError}=require('./local-library.cjs');
const {prepareBatchImport,revalidateBatchImport}=require('./batch-import.cjs');
const {messageText,errorResult,publicIssue,publicUnpaired,publicBatchRow}=require('./localization.cjs');

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
async function readSelected(file,expected){
  const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const stat=await handle.stat();
    if(!stat.isFile()||!stat.size||stat.size>30*1024*1024)throw new LibraryError('INVALID_IMAGE','图片无效或超过 30 MiB');
    if(expected&&(stat.dev!==expected.dev||stat.ino!==expected.ino||stat.size!==expected.size))throw new LibraryError('CONFLICT','所选图片已变化，请重新选择');
    const bytes=Buffer.alloc(stat.size);let offset=0;
    while(offset<bytes.length){const read=await handle.read(bytes,offset,bytes.length-offset,offset);if(!read.bytesRead)throw new LibraryError('CONFLICT','图片内容已变化');offset+=read.bytesRead;}
    const extra=await handle.read(Buffer.alloc(1),0,1,bytes.length),after=await handle.stat(),current=await fs.lstat(file);
    if(extra.bytesRead||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs||current.dev!==stat.dev||current.ino!==stat.ino||current.isSymbolicLink())throw new LibraryError('CONFLICT','图片文件已变化，请重新选择');
    return {bytes,stat};
  }finally{await handle.close();}
}
function imageMime(bytes){
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'image/webp';
  throw new LibraryError('INVALID_IMAGE','仅支持真实 PNG、JPEG 或 WebP 图片');
}
function createLocalAdapter({app,ipcMain,dialog,shell,protocol,nativeImage,BrowserWindow,rendererURL,trustedSender,sourceRoot,defaultRoot,legacyRoot}){
  let library,generation=0,activeOperations=0,switching=false,startupError=null;
  let liveLocale='zh';
  const text=key=>messageText(key,liveLocale);
  const selections=new Map();
  const batchImages=new Map(),batchManifests=new Map(),batchPreviews=new Map();
  const batchToken=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const batchLifetime=30*60*1000;
  function pruneBatch(){for(const map of [batchImages,batchManifests,batchPreviews])for(const [key,value]of map)if(value.generation!==generation||Date.now()-value.created>batchLifetime)map.delete(key);}
  function batchPayload(value,keys){if(!plain(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new LibraryError('INVALID_INPUT','批量导入参数无效');}
  async function selectedBatch(map,token){
    pruneBatch();const selected=typeof token==='string'&&batchToken.test(token)?map.get(token):null;
    if(!selected)throw new LibraryError('INVALID_BATCH_SELECTION','请重新选择图片文件夹和提示词 JSON');
    const current=await fs.lstat(selected.path);
    if(current.isSymbolicLink()||current.dev!==selected.dev||current.ino!==selected.ino||await fs.realpath(selected.path)!==selected.path||selected.kind==='manifest'&&(!current.isFile()||current.size!==selected.size)||selected.kind==='images'&&!current.isDirectory())throw new LibraryError('CONFLICT','所选批量导入来源已变化，请重新选择');
    return selected;
  }
  function validateImage(bytes){
    imageMime(bytes);
    if(bytes.length>30*1024*1024)throw new LibraryError('INVALID_IMAGE','图片不能超过 30 MiB');
    const image=nativeImage.createFromBuffer(bytes),size=image.getSize();
    if(image.isEmpty()||size.width<1||size.height<1||size.width>12000||size.height>12000)throw new LibraryError('INVALID_IMAGE','图片无法解码或尺寸超过限制');
  }
  const newLibrary=()=>new LocalLibrary({trashItem:file=>shell.trashItem(file),validateImage:(value,info)=>validateImage(Buffer.isBuffer(value)?value:info.buffer)});
  function decorate(state){
    const item=value=>({...value,image_url:`portrait-media://asset/${value.id}?revision=${value.revision}&library=${generation}`});
    if(state.items)return {...state,items:state.items.map(item)};
    if(state.item)return {...state,item:item(state.item)};
    return state;
  }
  async function readLibrary(method,...args){
    if(switching)throw new LibraryError('BUSY','正在切换素材目录');
    const captured=generation,service=library;activeOperations++;
    try{const state=await service[method](...args);if(captured!==generation)throw new LibraryError('CONFLICT','素材目录已变化，请刷新');return decorate(state);}
    finally{activeOperations--;}
  }
  async function saveRoot(root){
    const directory=app.getPath('userData');await fs.mkdir(directory,{recursive:true});
    const target=path.join(directory,'library-config.json');
    const existing=await fs.lstat(target).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
    if(existing?.isSymbolicLink())throw new LibraryError('INVALID_DIRECTORY','目录配置不能是符号链接');
    const temporary=path.join(directory,`.library-config-${randomUUID()}.tmp`),handle=await fs.open(temporary,'wx',0o600);
    try{await handle.writeFile(JSON.stringify({version:1,root})+'\n');await handle.sync();}finally{await handle.close();}
    try{await fs.rename(temporary,target);}catch(error){await fs.unlink(temporary).catch(()=>{});throw error;}
  }
  async function configure(root,persist=true){
    if(switching||activeOperations)throw new LibraryError('BUSY','正在处理素材，请稍后切换目录');
    switching=true;
    try{
      const candidate=newLibrary(),state=await candidate.open(root);
      if(persist)await saveRoot(state.root);
      library=candidate;generation++;startupError=null;selections.clear();batchImages.clear();batchManifests.clear();batchPreviews.clear();return decorate(state);
    }finally{switching=false;}
  }
  async function selectedImage(token){
    const selected=typeof token==='string'?selections.get(token):null;
    if(!selected||selected.generation!==generation||Date.now()-selected.created>30*60*1000){
      if(typeof token==='string')selections.delete(token);
      throw new LibraryError('INVALID_IMAGE_SELECTION','请重新选择要导入的图片');
    }
    const {bytes}=await readSelected(selected.path,selected);
    if(hash(bytes)!==selected.sha256)throw new LibraryError('CONFLICT','所选图片已变化，请重新选择');
    validateImage(bytes);return selected;
  }
  async function mutate(method,value){
    if(switching)throw new LibraryError('BUSY','正在切换素材目录');
    if(!plain(value))throw new LibraryError('INVALID_INPUT','素材参数无效');
    const allowed=method==='remove'?['id','expectedVersion','expectedRevision','confirmed']:['id','label','type','prompts','expectedVersion','expectedRevision','imageToken'];
    if(Object.keys(value).some(key=>!allowed.includes(key)))throw new LibraryError('INVALID_INPUT','素材参数包含不允许的字段');
    const captured=generation;activeOperations++;
    try{
      const {imageToken,...payload}=value;
      const selected=method==='create'||imageToken!=null?await selectedImage(imageToken):null;
      if(captured!==generation)throw new LibraryError('CONFLICT','素材目录已变化，请刷新');
      const source=selected?{path:selected.path,sha256:selected.sha256,dev:selected.dev,ino:selected.ino,size:selected.size}:undefined;
      const state=await library[method](payload,...(method==='remove'?[]:[source]));
      if(selected)selections.delete(imageToken);return decorate(state);
    }finally{activeOperations--;}
  }
  function register(channel,handler){
    ipcMain.handle(channel,async(event,...args)=>{
      if(!trustedSender(event,rendererURL))return errorResult({code:'FORBIDDEN'},liveLocale);
      try{return {ok:true,data:await handler(event,...args)};}catch(error){return errorResult(error,liveLocale);}
    });
  }
  async function mediaResponse(request){
    activeOperations++;
    try{
      const captured=generation,service=library;
      if(request.method!=='GET')return new Response(null,{status:405});
      const url=new URL(request.url);if(url.username||url.password||url.port||url.hash)return new Response(null,{status:403});
      let selected;
      if(url.hostname==='asset'&&/^\/[1-9]\d{0,5}$/.test(url.pathname)){
        if([...url.searchParams.keys()].some(key=>!['revision','library'].includes(key))||url.searchParams.getAll('revision').length!==1||url.searchParams.getAll('library').length!==1||Number(url.searchParams.get('library'))!==generation||switching)return new Response(null,{status:403});
        const id=Number(url.pathname.slice(1)),revision=Number(url.searchParams.get('revision')),current=await service.get(id);
        if(!Number.isSafeInteger(revision)||current.item.revision!==revision)return new Response(null,{status:404});
        selected=await service.imageForId(id);
      }else if(url.hostname==='import'&&/^\/[0-9a-f-]{36}$/.test(url.pathname)&&!url.search){selected=await selectedImage(url.pathname.slice(1));}
      else return new Response(null,{status:403});
      const {bytes}=await readSelected(selected.path,selected.ino!=null?selected:undefined);
      if(captured!==generation||switching)return new Response(null,{status:403});
      if(selected.sha256&&hash(bytes)!==selected.sha256)throw new LibraryError('CONFLICT','图片内容已变化');
      return new Response(bytes,{headers:{'Content-Type':imageMime(bytes),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    }catch{return new Response(null,{status:404});}finally{activeOperations--;}
  }
  async function initialise(){
    library=newLibrary();
    try{
      let initial=process.env.PORTRAIT_STUDIO_LIBRARY_DIR,migrateDefault=false;
      if(initial&&!path.isAbsolute(initial))throw new LibraryError('INVALID_DIRECTORY','素材目录必须是绝对路径');
      if(!initial){
        const file=path.join(app.getPath('userData'),'library-config.json');
        const stat=await fs.lstat(file).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
        if(stat){
          if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw new LibraryError('INVALID_DIRECTORY','素材目录配置无效');
          const saved=JSON.parse(await fs.readFile(file,'utf8'));
          if(saved.version!==1||typeof saved.root!=='string'||!path.isAbsolute(saved.root))throw new LibraryError('INVALID_DIRECTORY','素材目录配置无效');
          initial=legacyRoot&&defaultRoot&&saved.root===legacyRoot?defaultRoot:saved.root;
          migrateDefault=initial!==saved.root;
        }else initial=defaultRoot||(!app.isPackaged?sourceRoot:null);
      }
      if(initial)await configure(initial,migrateDefault);
    }catch(error){startupError=error;}
    protocol.handle('portrait-media',mediaResponse);
    register('library-ui-language',(_event,locale,...extra)=>{
      if(extra.length||!['en','zh'].includes(locale))throw new LibraryError('INVALID_LOCALE','界面语言无效');
      liveLocale=locale;return {locale};
    });
    register('library-list',async()=>{if(startupError)throw startupError;return readLibrary('list',{refresh:true});});
    register('library-get',(_event,id)=>readLibrary('get',id));
    register('library-choose',async event=>{
      if(switching||activeOperations)throw new LibraryError('BUSY','正在处理素材，请稍后切换目录');
      activeOperations++;let result;
      try{result=await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender),{title:text('native.libraryTitle'),message:text('native.libraryMessage'),buttonLabel:text('native.libraryButton'),properties:['openDirectory','createDirectory']});}finally{activeOperations--;}
      if(result.canceled||result.filePaths.length!==1)return {cancelled:true};return configure(result.filePaths[0]);
    });
    register('library-image-choose',async event=>{
      if(switching)throw new LibraryError('BUSY','正在切换素材目录');
      if(!(await library.list()).configured)throw new LibraryError('NOT_CONFIGURED','请先选择本地素材目录');
      const captured=generation;activeOperations++;
      try{
        const result=await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender),{title:text('native.imageTitle'),message:text('native.imageMessage'),buttonLabel:text('native.imageButton'),properties:['openFile'],filters:[{name:text('native.imageFilter'),extensions:['png','jpg','jpeg','webp']}]});
        if(result.canceled||result.filePaths.length!==1)return {cancelled:true};
        const file=await fs.realpath(result.filePaths[0]),{bytes,stat}=await readSelected(file);validateImage(bytes);
        if(captured!==generation)throw new LibraryError('CONFLICT','素材目录已变化，请重新选择');
        for(const [token,item]of selections)if(Date.now()-item.created>30*60*1000)selections.delete(token);
        if(selections.size>=64)throw new LibraryError('BUSY','已选图片过多，请稍后重试');
        const token=randomUUID();selections.set(token,{path:file,mime:imageMime(bytes),sha256:hash(bytes),dev:stat.dev,ino:stat.ino,size:stat.size,generation,created:Date.now()});
        return {token,previewURL:`portrait-media://import/${token}`,name:path.basename(file)};
      }finally{activeOperations--;}
    });
    register('library-create',(_event,value)=>mutate('create',value));
    register('library-update',(_event,value)=>mutate('update',value));
    register('library-delete',(_event,value)=>mutate('remove',value));
    register('library-image-release',(_event,token)=>{
      if(typeof token!=='string'||!/^[0-9a-f-]{36}$/.test(token))throw new LibraryError('INVALID_INPUT','所选图片凭据无效');
      selections.delete(token);return {released:true};
    });
    async function chooseBatch(event,kind){
      if(switching||activeOperations)throw new LibraryError('BUSY','正在处理素材，请稍后选择来源');
      if(!(await library.list()).configured)throw new LibraryError('NOT_CONFIGURED','请先选择素材保存位置');
      const captured=generation;activeOperations++;
      try{
        const result=await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender),kind==='images'?{title:text('native.batchImagesTitle'),message:text('native.batchImagesMessage'),buttonLabel:text('native.batchImagesButton'),properties:['openDirectory']}:{title:text('native.batchManifestTitle'),message:text('native.batchManifestMessage'),buttonLabel:text('native.batchManifestButton'),properties:['openFile'],filters:[{name:text('native.jsonFilter'),extensions:['json']}]});
        if(result.canceled||result.filePaths.length!==1)return {cancelled:true};
        const chosen=result.filePaths[0],stat=await fs.lstat(chosen);
        if(stat.isSymbolicLink()||kind==='images'&&!stat.isDirectory()||kind==='manifest'&&(!stat.isFile()||!stat.size||stat.size>32*1024*1024||path.extname(chosen).toLowerCase()!=='.json'))throw new LibraryError('INVALID_BATCH_SELECTION','请选择真实的图片文件夹或有效的 JSON 文件');
        const selectedPath=await fs.realpath(chosen),current=await fs.lstat(selectedPath);
        if(current.dev!==stat.dev||current.ino!==stat.ino||captured!==generation)throw new LibraryError('CONFLICT','来源或素材库已变化，请重新选择');
        pruneBatch();const map=kind==='images'?batchImages:batchManifests;
        if(map.size>=64)throw new LibraryError('BUSY','待选来源过多，请关闭导入窗口后重试');
        const selectionId=randomUUID();map.set(selectionId,{path:selectedPath,kind,dev:stat.dev,ino:stat.ino,size:stat.size,generation,created:Date.now()});
        return {selectionId,path:selectedPath,name:path.basename(selectedPath)};
      }finally{activeOperations--;}
    }
    register('library-batch-images-choose',event=>chooseBatch(event,'images'));
    register('library-batch-manifest-choose',event=>chooseBatch(event,'manifest'));
    register('library-batch-preview',async(_event,value)=>{
      batchPayload(value,['imageSelectionId','manifestSelectionId','type']);
      if(!['photo','art'].includes(value.type))throw new LibraryError('INVALID_INPUT','请选择本批次默认质感');
      if(switching||activeOperations)throw new LibraryError('BUSY','正在处理素材，请稍后预览');
      const captured=generation;activeOperations++;
      try{
        const images=await selectedBatch(batchImages,value.imageSelectionId),manifest=await selectedBatch(batchManifests,value.manifestSelectionId);
        const plan=await prepareBatchImport({imageDirectory:images.path,manifestPath:manifest.path,type:value.type,validateImage});
        const preview=await library.previewBatch(plan);
        if(captured!==generation)throw new LibraryError('CONFLICT','素材库已变化，请重新预览');
        pruneBatch();if(batchPreviews.size>=64)throw new LibraryError('BUSY','待确认批次过多，请关闭导入窗口后重试');
        const previewId=randomUUID();batchPreviews.set(previewId,{plan,revision:preview.revision,generation,created:Date.now(),imageSelectionId:value.imageSelectionId,manifestSelectionId:value.manifestSelectionId});
        const known=new Map(preview.records.map(row=>[row.recordIndex??plan.records.find(item=>item.id===row.id)?.recordIndex,row]));
        const rows=plan.recordResults.map(row=>{
          const target=known.get(row.index),source=plan.records.find(item=>item.recordIndex===row.index);
          return publicBatchRow(row,target,source);
        });
        return {previewId,root:library.root,revision:preview.revision,type:value.type,sourceDirectory:plan.sourceDirectory,manifestPath:plan.manifestPath,manifestSha256:plan.manifestSha256,total:plan.counts.total,matched:plan.counts.matched,importable:preview.summary.importable,skipped:preview.summary.skipped,conflicts:preview.summary.conflicts,issues:plan.issues.map(publicIssue),unpaired:plan.unpaired.map(publicUnpaired),items:rows,canImport:preview.canImport};
      }finally{activeOperations--;}
    });
    register('library-batch-commit',async(_event,value)=>{
      batchPayload(value,['previewId','confirmed','expectedVersion']);
      if(value.confirmed!==true)throw new LibraryError('CONFIRMATION_REQUIRED','请确认预览后再批量导入');
      pruneBatch();const preview=typeof value.previewId==='string'&&batchToken.test(value.previewId)?batchPreviews.get(value.previewId):null;
      if(!preview)throw new LibraryError('INVALID_BATCH_SELECTION','批次预览已过期，请重新预览');
      if(!Number.isSafeInteger(value.expectedVersion)||value.expectedVersion!==preview.revision)throw new LibraryError('CONFLICT','素材库版本已变化，请重新预览');
      if(switching||activeOperations)throw new LibraryError('BUSY','正在处理素材，请稍后导入');
      const captured=generation;activeOperations++;
      try{
        await selectedBatch(batchImages,preview.imageSelectionId);await selectedBatch(batchManifests,preview.manifestSelectionId);
        await revalidateBatchImport(preview.plan);
        const state=await library.importBatch(preview.plan,{expectedVersion:value.expectedVersion,confirmed:true});
        if(captured!==generation)throw new LibraryError('CONFLICT','素材库已变化，请重新载入');
        const {batch,...snapshot}=state;
        batchPreviews.delete(value.previewId);batchImages.delete(preview.imageSelectionId);batchManifests.delete(preview.manifestSelectionId);
        return {snapshot:decorate(snapshot),report:batch};
      }finally{activeOperations--;}
    });
    register('library-batch-cancel',(_event,value={})=>{
      batchPayload(value,['previewId','imageSelectionId','manifestSelectionId']);
      if(Object.values(value).some(token=>token!=null&&(typeof token!=='string'||!batchToken.test(token))))throw new LibraryError('INVALID_BATCH_SELECTION','批次凭据无效');
      let released=0;
      for(const [key,map]of [['previewId',batchPreviews],['imageSelectionId',batchImages],['manifestSelectionId',batchManifests]])if(value[key]!=null){if(typeof value[key]!=='string'||!batchToken.test(value[key]))throw new LibraryError('INVALID_BATCH_SELECTION','批次凭据无效');if(map.delete(value[key]))released++;}
      return {released};
    });
  }
  async function imageToOpen(value){
    if(switching)throw new LibraryError('BUSY','正在切换素材目录');
    const captured=generation,service=library;activeOperations++;
    try{
      if(!(await service.list()).configured)return null;
      if(!plain(value)||Object.keys(value).some(key=>!['id','revision'].includes(key))||!Number.isSafeInteger(value.id)||!Number.isSafeInteger(value.revision))throw new LibraryError('INVALID_INPUT','原图参数无效');
      const current=await service.get(value.id);if(current.item.revision!==value.revision)throw new LibraryError('CONFLICT','素材已变化，请刷新');
      const selected=await service.imageForId(value.id);
      if(captured!==generation)throw new LibraryError('CONFLICT','素材目录已变化，请刷新');
      return selected.path;
    }finally{activeOperations--;}
  }
  return {initialise,imageToOpen};
}
module.exports={createLocalAdapter};
