const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const data = require('../assets/selected-prompts.json');
const translations = require('../assets/prompts.zh.json');
const version = require('../package.json').version;
const root = path.resolve(__dirname,'..');
const packaged = process.env.PORTRAIT_STUDIO_EXECUTABLE;
const kind = process.env.PORTRAIT_STUDIO_VERIFICATION_NAME || `${packaged ? 'packaged' : 'react'}-${version}`;
const output = path.join(root,'.verification');
const profile = fs.mkdtempSync(path.join(os.tmpdir(),`portrait-${kind}-`));
const checks=[];
const errors=[];
const clipboardChecks=[];
const languageChecks=[];
const visualComparisons=[];

(async () => {
  fs.mkdirSync(output,{recursive:true});
  const app = await electron.launch({
    executablePath: packaged || require('electron'),
    args: packaged ? [] : [root],
    env: {...process.env,PORTRAIT_STUDIO_USER_DATA_DIR:profile},
  });
  let originalClipboard;
  try {
    const page=await app.firstWindow();
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
    originalClipboard=await app.evaluate(({clipboard})=>{
      globalThis.__portraitOriginalClipboard={text:clipboard.readText(),html:clipboard.readHTML(),rtf:clipboard.readRTF(),image:clipboard.readImage()};
      return true;
    });
    const galleryLanguage=page.locator('.toolbar').getByRole('group',{name:'提示词语言'});
    const detailLanguage=page.locator('#detailDialog').getByRole('group',{name:'提示词语言'});
    const languageName=language=>language==='zh'?'中文':'English';
    const promptFor=(item,language)=>language==='zh'?translations[String(item.id)]:item.prompt;
    async function assertLanguage(group,language){
      await expect(group.getByRole('button',{name:languageName(language),exact:true})).toHaveAttribute('aria-pressed','true');
      await expect(group.getByRole('button',{name:languageName(language==='en'?'zh':'en'),exact:true})).toHaveAttribute('aria-pressed','false');
    }
    async function assertCopy(action,text,label){
      // A fresh value proves this action wrote the clipboard, even when two
      // consecutive entry points are expected to copy the same full prompt.
      await app.evaluate(({clipboard},sentinel)=>clipboard.writeText(sentinel),`Portrait Studio verification ${clipboardChecks.length}`);
      await action();
      await expect.poll(()=>app.evaluate(({clipboard})=>clipboard.readText()),{message:label}).toBe(text);
      clipboardChecks.push(label);
    }
    await assertLanguage(galleryLanguage,'en');
    languageChecks.push('fresh isolated profile defaults to English');
    await expect(page.locator('.portrait-card')).toHaveCount(13);
    await expect(page.locator('#allCount')).toHaveText('13');
    await expect(page.locator('#photoCount')).toHaveText('8');
    await expect(page.locator('#artCount')).toHaveText('5');
    const security=await app.evaluate(({BrowserWindow,app})=>{
      const win=BrowserWindow.getAllWindows()[0];
      const prefs=win.webContents.getLastWebPreferences();
      return {contextIsolation:prefs.contextIsolation,nodeIntegration:prefs.nodeIntegration,sandbox:prefs.sandbox,webSecurity:prefs.webSecurity,packaged:app.isPackaged,userData:app.getPath('userData'),pid:process.pid};
    });
    expect(security.contextIsolation).toBe(true);expect(security.nodeIntegration).toBe(false);expect(security.sandbox).toBe(true);expect(security.webSecurity).toBe(true);
    expect(security.userData).toBe(profile);
    expect(await page.evaluate(()=>typeof window.require)).toBe('undefined');
    expect(await page.evaluate(()=>Object.keys(window.portraitStudio).sort())).toEqual(['copyText','openImage']);
    checks.push('13 portraits, category counts, sandboxed renderer, isolated profile, narrow preload');

    for (const [width,height] of [[1440,920],[2048,1280]]) {
      await page.setViewportSize({width,height});
      await page.locator('.portrait-image').evaluateAll(async images=>{for(const image of images){image.loading='eager';await image.decode();}});
      for(const dense of [false,true]){
        if((await page.locator('#gallery').getAttribute('class')).includes('dense')!==dense)await page.locator('#gridToggle').click();
        await page.mouse.move(0,0);
        const screenshot=`${kind}-${width}x${height}-${dense?'dense':'normal'}.png`;
        const languageControl=await galleryLanguage.evaluate(control=>{
          const {x,y,width,height,top,right,bottom,left}=control.getBoundingClientRect();
          return {x,y,width,height,top,right,bottom,left};
        });
        await page.screenshot({path:path.join(output,screenshot),scale:'css',animations:'disabled'});
        visualComparisons.push({screenshot,viewport:{width,height},density:dense?'dense':'normal',language:'en',languageControl});
      }
    }
    expect(await page.locator('.portrait-image').evaluateAll(images=>images.every(image=>image.complete&&image.naturalWidth===1024&&image.naturalHeight===1536))).toBe(true);
    const scroll=await page.locator('main').evaluate(main=>{main.scrollTop=main.scrollHeight;return {height:main.clientHeight,scrollHeight:main.scrollHeight,top:main.scrollTop};});
    expect(scroll.top).toBeGreaterThan(0);
    await expect(page.locator('.portrait-card').last()).toBeInViewport();
    await page.locator('main').evaluate(main=>{main.scrollTop=0;});
    checks.push('all original images decoded, both densities and sizes captured, bottom row reachable');

    await page.locator('[data-filter="photo"]').click();await expect(page.locator('.portrait-card')).toHaveCount(8);
    await page.locator('#searchInput').fill('RAINY');await expect(page.locator('.portrait-card')).toHaveCount(1);await expect(page.locator('.card-title')).toHaveText('雨夜街景');
    await page.locator('#searchInput').fill('031');await expect(page.locator('.portrait-card')).toHaveCount(1);
    await page.locator('#searchInput').fill('photorealistic-natural');await expect(page.locator('.portrait-card')).toHaveCount(0);await expect(page.locator('#emptyState')).toBeVisible();
    await page.locator('#searchInput').fill('');
    await page.locator('[data-filter="art"]').click();await expect(page.locator('.portrait-card')).toHaveCount(5);
    await page.locator('.portrait-card').first().click();await expect(page.locator('#detailTitle')).toHaveText('文艺复兴');
    await page.keyboard.press('ArrowLeft');await expect(page.locator('#detailTitle')).toHaveText('超写实油画');
    await page.keyboard.press('ArrowRight');await expect(page.locator('#detailTitle')).toHaveText('文艺复兴');
    await page.keyboard.press('Escape');await expect(page.locator('#detailDialog')).not.toBeVisible();
    await page.locator('[data-filter="all"]').click();await expect(page.locator('.portrait-card')).toHaveCount(13);
    await page.keyboard.press('Meta+k');await expect(page.locator('#searchInput')).toBeFocused();
    checks.push('filter/search combinations, original search semantics, empty state, filtered detail wrap and shortcuts');

    await page.setViewportSize({width:1440,height:920});
    if((await page.locator('#gallery').getAttribute('class')).includes('dense'))await page.locator('#gridToggle').click();
    const first=page.locator('.portrait-card').first();
    await first.focus();await page.keyboard.press('Enter');await expect(page.locator('#detailDialog')).toBeVisible();
    await expect(page.locator('#detailPrompt')).toHaveText(data[0].prompt);
    await page.mouse.move(0,0);
    await page.screenshot({path:path.join(output,`${kind}-detail-1440x920.png`),scale:'css',animations:'disabled'});
    await assertCopy(()=>page.keyboard.press('Meta+Enter'),data[0].prompt,'English first detail Cmd+Enter');
    expect(await page.evaluate(text=>window.portraitStudio.copyText(text),data[0].prompt)).toBe(true);
    await expect(page.locator('#toast')).toHaveClass('toast show');
    await page.locator('#closeDialog').click();await expect(page.locator('#detailDialog')).not.toBeVisible();
    await first.focus();await page.keyboard.press('Space');await expect(page.locator('#detailDialog')).toBeVisible();
    await assertCopy(()=>page.locator('#detailCopy').click(),data[0].prompt,'English first detail button');
    await page.mouse.click(5,5);await expect(page.locator('#detailDialog')).not.toBeVisible();
    await first.hover();await assertCopy(()=>first.locator('.copy-button').click(),data[0].prompt,'English first card button');
    await expect(first.locator('.copy-button')).toHaveText('✓');await expect(page.locator('#detailDialog')).not.toBeVisible();
    await first.focus();await assertCopy(()=>page.keyboard.press('c'),data[0].prompt,'English first card C');
    await first.locator('.copy-button').focus();await assertCopy(()=>page.keyboard.press('Enter'),data[0].prompt,'English copy button Enter');await expect(page.locator('#detailDialog')).not.toBeVisible();
    checks.push('exact full-prompt native clipboard, toast, hover copy, card Enter/Space/C, button keyboard isolation, all close methods');

    for(const language of ['en','zh']){
      await galleryLanguage.getByRole('button',{name:languageName(language),exact:true}).click();
      await assertLanguage(galleryLanguage,language);
      await expect(page.locator('.portrait-card')).toHaveCount(13);
      for(const [index,item] of data.entries()){
        const card=page.locator('.portrait-card').nth(index);
        const expected=promptFor(item,language);
        const number=String(item.id).padStart(3,'0');
        await card.scrollIntoViewIfNeeded();
        await card.hover();
        await assertCopy(()=>card.locator('.copy-button').click(),expected,`${language} ${number} card button`);
        await expect(page.locator('#detailDialog')).not.toBeVisible();
        await card.focus();
        await assertCopy(()=>page.keyboard.press('c'),expected,`${language} ${number} card C`);
        await card.click();
        await expect(page.locator('#detailDialog')).toBeVisible();
        await expect(page.locator('#detailTitle')).toHaveText(item.label);
        await expect.poll(()=>page.locator('#detailPrompt').textContent()).toBe(expected);
        await expect(page.locator('#detailPrompt')).toHaveAttribute('lang',language==='zh'?'zh-CN':'en');
        await assertLanguage(detailLanguage,language);
        await assertCopy(()=>page.locator('#detailCopy').click(),expected,`${language} ${number} detail button`);
        await assertCopy(()=>page.keyboard.press('Meta+Enter'),expected,`${language} ${number} detail Cmd+Enter`);
        if(language==='zh'&&index===0){
          await page.mouse.move(0,0);
          await page.screenshot({path:path.join(output,`${kind}-detail-zh-1440x920.png`),scale:'css',animations:'disabled'});
        }
        await page.locator('#closeDialog').click();
        await expect(page.locator('#detailDialog')).not.toBeVisible();
      }
      languageChecks.push(`${language}: all 13 exact full prompts displayed and copied by all four entry points`);
    }
    checks.push('26 complete prompt displays and 104 native clipboard actions across English/Chinese and four entry points');

    await first.click();
    for(const language of ['en','zh','en','zh']){
      await detailLanguage.getByRole('button',{name:languageName(language),exact:true}).click();
      await assertLanguage(detailLanguage,language);
      await expect.poll(()=>page.locator('#detailPrompt').textContent()).toBe(promptFor(data[0],language));
    }
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#detailTitle')).toHaveText(data[1].label);
    await expect.poll(()=>page.locator('#detailPrompt').textContent()).toBe(promptFor(data[1],'zh'));
    await page.keyboard.press('ArrowLeft');
    await expect.poll(()=>page.locator('#detailPrompt').textContent()).toBe(promptFor(data[0],'zh'));
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#detailTitle')).toHaveText(data.at(-1).label);
    await expect.poll(()=>page.locator('#detailPrompt').textContent()).toBe(promptFor(data.at(-1),'zh'));
    await detailLanguage.getByRole('button',{name:'English',exact:true}).click();
    await expect.poll(()=>page.locator('#detailPrompt').textContent()).toBe(data.at(-1).prompt);
    await page.keyboard.press('Escape');
    await assertLanguage(galleryLanguage,'en');
    await galleryLanguage.getByRole('button',{name:'中文',exact:true}).click();
    await page.locator('[data-filter="art"]').click();
    await expect(page.locator('.portrait-card')).toHaveCount(5);
    const firstArt=data.find(item=>item.id===43);
    await page.locator('.portrait-card').first().click();
    await expect.poll(()=>page.locator('#detailPrompt').textContent()).toBe(promptFor(firstArt,'zh'));
    await page.keyboard.press('ArrowLeft');
    await expect.poll(()=>page.locator('#detailPrompt').textContent()).toBe(promptFor(data.at(-1),'zh'));
    await page.keyboard.press('Escape');
    await page.locator('[data-filter="photo"]').click();
    await expect(page.locator('.portrait-card')).toHaveCount(8);
    await page.locator('#searchInput').fill('雨夜');
    await expect(page.locator('.portrait-card')).toHaveCount(1);
    await page.locator('.portrait-card').first().click();
    const rainy=data.find(item=>item.id===31);
    await expect.poll(()=>page.locator('#detailPrompt').textContent()).toBe(promptFor(rainy,'zh'));
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#detailTitle')).toHaveText(rainy.label);
    await assertCopy(()=>page.keyboard.press('Meta+Enter'),promptFor(rainy,'zh'),'Chinese filtered single-item detail Cmd+Enter');
    await page.keyboard.press('Escape');
    await page.locator('#searchInput').fill('RAINY');
    await expect(page.locator('.portrait-card')).toHaveCount(1);
    await page.locator('#searchInput').fill('photorealistic-natural');
    await expect(page.locator('.portrait-card')).toHaveCount(0);
    await expect(page.locator('#emptyState')).toBeVisible();
    await assertLanguage(galleryLanguage,'zh');
    await page.locator('#searchInput').fill('');
    await page.locator('[data-filter="all"]').click();
    await expect(page.locator('.portrait-card')).toHaveCount(13);
    languageChecks.push('repeated in-dialog switches, global language synchronization, all/filtered detail navigation, Chinese-label and English-filename search');

    expect(await page.evaluate(()=>localStorage.getItem('portraitStudio.promptLanguage'))).toBe('zh');
    await page.reload();
    await expect(page.locator('.portrait-card')).toHaveCount(13);
    await assertLanguage(galleryLanguage,'zh');
    await first.click();
    await expect.poll(()=>page.locator('#detailPrompt').textContent()).toBe(promptFor(data[0],'zh'));
    await page.keyboard.press('Escape');
    await page.evaluate(()=>localStorage.setItem('portraitStudio.promptLanguage','invalid-value'));
    await page.reload();
    await expect(page.locator('.portrait-card')).toHaveCount(13);
    await assertLanguage(galleryLanguage,'en');
    await first.click();
    await expect.poll(()=>page.locator('#detailPrompt').textContent()).toBe(data[0].prompt);
    await page.keyboard.press('Escape');
    await galleryLanguage.getByRole('button',{name:'English',exact:true}).click();
    expect(await page.evaluate(()=>localStorage.getItem('portraitStudio.promptLanguage'))).toBe('en');
    await page.reload();
    await expect(page.locator('.portrait-card')).toHaveCount(13);
    await assertLanguage(galleryLanguage,'en');
    languageChecks.push('Chinese preference survives reload, invalid preference falls back to English, English preference survives reload');
    checks.push('repeated switches, unchanged filters/search, filtered navigation, persistent language and invalid-value fallback');

    for(const value of ['../main.js','/etc/passwd','missing.png',null,{}]){
      expect(await page.evaluate(value=>window.portraitStudio.openImage(value),value)).toBe(false);
    }
    expect(await page.evaluate(()=>window.portraitStudio.copyText({value:'invalid'}))).toBe(false);
    expect(await page.evaluate(()=>window.portraitStudio.copyText('x'.repeat(65537)))).toBe(false);
    const beforeWindows=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length);
    await page.evaluate(()=>window.open('https://example.com'));
    expect(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length)).toBe(beforeWindows);
    checks.push('invalid/traversal IPC rejected, clipboard limits enforced, popup denied');

    // Record the real system open operation; do not replace it with a success stub.
    await app.evaluate(({shell})=>{
      const original=shell.openPath;
      globalThis.__portraitOpenResults=[];
      shell.openPath=async file=>{const result=await original(file);globalThis.__portraitOpenResults.push({file,result});return result;};
    });
    await first.click();await page.locator('#detailOpen').click();
    await expect.poll(()=>app.evaluate(()=>globalThis.__portraitOpenResults.length)).toBe(1);
    const opened=await app.evaluate(()=>globalThis.__portraitOpenResults[0]);
    expect(opened.result).toBe('');
    expect(fs.readFileSync(opened.file)).toEqual(fs.readFileSync(path.join(root,'assets/images',data[0].image)));
    if(packaged)expect(opened.file.includes('app.asar')).toBe(false);
    checks.push('real system original-image open succeeded with identical bytes outside ASAR');
    await page.keyboard.press('Escape');
    await page.setViewportSize({width:1080,height:720});await expect(page.locator('.portrait-card')).toHaveCount(13);
    const columns=await page.locator('#gallery').evaluate(gallery=>getComputedStyle(gallery).gridTemplateColumns.split(' ').length);
    expect(columns).toBe(3);
    await page.locator('#gridToggle').click();expect(await page.locator('#gallery').evaluate(gallery=>getComputedStyle(gallery).gridTemplateColumns.split(' ').length)).toBe(4);
    checks.push('minimum viewport uses original responsive 3/4-column layouts');
    expect(errors).toEqual([]);
    const bilingual={promptIds:data.map(item=>item.id),languages:['en','zh'],clipboardChecks,languageChecks};
    const report={status:'passed',kind,executable:packaged||require('electron'),security,scroll,opened,bilingual,visualComparisons,checks,errors};
    fs.writeFileSync(path.join(output,`${kind}-verification.json`),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report,null,2));
  } catch(error) {
    fs.writeFileSync(path.join(output,`${kind}-verification.json`),JSON.stringify({status:'failed',kind,checks,errors,bilingual:{clipboardChecks,languageChecks},visualComparisons,error:error.stack},null,2)+'\n');
    throw error;
  } finally {
    if(originalClipboard)await app.evaluate(({clipboard})=>clipboard.write(globalThis.__portraitOriginalClipboard)).catch(()=>{});
    await app.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
