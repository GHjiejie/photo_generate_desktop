const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {LocalLibrary,LibraryError}=require('./local-library.cjs');

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
function errorResult(error){
  const code=error.code||'IO_ERROR',permission=['EACCES','EPERM','EROFS'].includes(code);
  return {ok:false,error:{code:permission?'PERMISSION_DENIED':code,message:permission?'没有目录或文件的读写权限':error instanceof LibraryError?error.message:'本地素材操作失败，请重试'}};
}

function createLocalAdapter({app,ipcMain,dialog,shell,protocol,nativeImage,BrowserWindow,rendererURL,trustedSender,sourceRoot}){
  let library,generation=0,activeOperations=0,switching=false,startupError=null;
  const selections=new Map();
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
      library=candidate;generation++;startupError=null;selections.clear();return decorate(state);
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
      if(!trustedSender(event,rendererURL))return {ok:false,error:{code:'FORBIDDEN',message:'请求来源无效'}};
      try{return {ok:true,data:await handler(event,...args)};}catch(error){return errorResult(error);}
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
      let initial=process.env.PORTRAIT_STUDIO_LIBRARY_DIR;
      if(initial&&!path.isAbsolute(initial))throw new LibraryError('INVALID_DIRECTORY','素材目录必须是绝对路径');
      if(!initial){
        const file=path.join(app.getPath('userData'),'library-config.json');
        const stat=await fs.lstat(file).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
        if(stat){
          if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw new LibraryError('INVALID_DIRECTORY','素材目录配置无效');
          const saved=JSON.parse(await fs.readFile(file,'utf8'));
          if(saved.version!==1||typeof saved.root!=='string'||!path.isAbsolute(saved.root))throw new LibraryError('INVALID_DIRECTORY','素材目录配置无效');
          initial=saved.root;
        }else if(!app.isPackaged)initial=sourceRoot;
      }
      if(initial)await configure(initial,false);
    }catch(error){startupError=error;}
    protocol.handle('portrait-media',mediaResponse);
    register('library-list',async()=>{if(startupError)throw startupError;return readLibrary('list',{refresh:true});});
    register('library-get',(_event,id)=>readLibrary('get',id));
    register('library-choose',async event=>{
      if(switching||activeOperations)throw new LibraryError('BUSY','正在处理素材，请稍后切换目录');
      activeOperations++;let result;
      try{result=await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender),{title:'选择本地素材仓库',properties:['openDirectory','createDirectory']});}finally{activeOperations--;}
      if(result.canceled||result.filePaths.length!==1)return {cancelled:true};return configure(result.filePaths[0]);
    });
    register('library-image-choose',async event=>{
      if(switching)throw new LibraryError('BUSY','正在切换素材目录');
      if(!(await library.list()).configured)throw new LibraryError('NOT_CONFIGURED','请先选择本地素材目录');
      const captured=generation;activeOperations++;
      try{
        const result=await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender),{title:'选择肖像图片',properties:['openFile'],filters:[{name:'肖像图片',extensions:['png','jpg','jpeg','webp']}]});
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
