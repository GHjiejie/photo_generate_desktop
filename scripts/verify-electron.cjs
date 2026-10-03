const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const data = require('../assets/selected-prompts.json');
const root = path.resolve(__dirname,'..');
const packaged = process.env.PORTRAIT_STUDIO_EXECUTABLE;
const kind = process.env.PORTRAIT_STUDIO_VERIFICATION_NAME || (packaged ? 'packaged' : 'react');
const output = path.join(root,'.verification');
const profile = fs.mkdtempSync(path.join(os.tmpdir(),`portrait-${kind}-`));
const checks=[];
const errors=[];

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
        await page.screenshot({path:path.join(output,`${kind}-${width}x${height}-${dense?'dense':'normal'}.png`),scale:'css',animations:'disabled'});
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
    await page.keyboard.press('Meta+Enter');
    expect(await app.evaluate(({clipboard})=>clipboard.readText())).toBe(data[0].prompt);
    expect(await page.evaluate(text=>window.portraitStudio.copyText(text),data[0].prompt)).toBe(true);
    await expect(page.locator('#toast')).toHaveClass('toast show');
    await page.locator('#closeDialog').click();await expect(page.locator('#detailDialog')).not.toBeVisible();
    await first.focus();await page.keyboard.press('Space');await expect(page.locator('#detailDialog')).toBeVisible();
    await page.locator('#detailCopy').click();expect(await app.evaluate(({clipboard})=>clipboard.readText())).toBe(data[0].prompt);
    await page.mouse.click(5,5);await expect(page.locator('#detailDialog')).not.toBeVisible();
    await first.hover();await first.locator('.copy-button').click();
    await expect(first.locator('.copy-button')).toHaveText('✓');await expect(page.locator('#detailDialog')).not.toBeVisible();
    expect(await app.evaluate(({clipboard})=>clipboard.readText())).toBe(data[0].prompt);
    await first.focus();await page.keyboard.press('c');expect(await app.evaluate(({clipboard})=>clipboard.readText())).toBe(data[0].prompt);
    await first.locator('.copy-button').focus();await page.keyboard.press('Enter');await expect(page.locator('#detailDialog')).not.toBeVisible();
    checks.push('exact full-prompt native clipboard, toast, hover copy, card Enter/Space/C, button keyboard isolation, all close methods');

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
    const report={status:'passed',kind,executable:packaged||require('electron'),security,scroll,opened,checks,errors};
    fs.writeFileSync(path.join(output,`${kind}-verification.json`),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report,null,2));
  } catch(error) {
    fs.writeFileSync(path.join(output,`${kind}-verification.json`),JSON.stringify({status:'failed',kind,checks,errors,error:error.stack},null,2)+'\n');
    throw error;
  } finally {
    if(originalClipboard)await app.evaluate(({clipboard})=>clipboard.write(globalThis.__portraitOriginalClipboard)).catch(()=>{});
    await app.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
