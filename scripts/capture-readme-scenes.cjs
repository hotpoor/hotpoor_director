// Extra documentation scenes, run by smoke-inference.cjs --readme.
// Operates only on that script's isolated fixture account and database.
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({win, js, wait, directory}) => {
  const capture = async name => {
    await wait("document.querySelector('#save-status').textContent.startsWith('已自动保存') || document.querySelector('#save-status').textContent==='已保存'");
    await new Promise(resolve => setTimeout(resolve, 350));
    fs.writeFileSync(path.join(directory, name), (await win.webContents.capturePage()).toPNG());
  };
  const reopen = async id => {
    await js("document.querySelector('#back-dashboard').click()");
    await wait(`!document.querySelector('#dashboard').hidden && !!document.querySelector('[data-project="${id}"]')`);
    await js(`document.querySelector('[data-project="${id}"]').click()`);
    await wait("!document.querySelector('#editor').hidden && document.querySelectorAll('[data-card]').length>=2");
    await js("document.querySelector('#fit-cards').click()");
  };
  win.setContentSize(1500, 1150);
  await js("document.querySelector('#close-upload-progress').click();document.querySelector('#open-storage-settings').click()");
  await wait("document.querySelectorAll('#storage-profile-list input').length===4");
  await capture('storage-profiles.png');
  await js("document.querySelector('#close-storage').click();document.querySelector('#open-inference-settings').click()");
  await wait("document.querySelectorAll('#inference-key-list input').length===2 && document.querySelector('#inference-status').textContent.includes('已配置')");
  await capture('keys-overview.png');
  await js("document.querySelector('#close-inference-settings').click()");
  win.setContentSize(1500, 1000);
  await js("document.querySelector('#close-upload-progress').click()");
  await wait("document.querySelector('#save-status').textContent.startsWith('已自动保存') || document.querySelector('#save-status').textContent==='已保存'");
  const projectId = await js(`(async()=>{
    const p=(await smokeApi('/api/projects')).projects[0];
    const full=await smokeApi('/api/projects/'+p.block_id);
    full.body.title='多图与多视频 · PIN 对比';
    full.body.canvas.cards=full.body.canvas.cards.filter(c=>c.type==='image'||c.type==='video');
    full.body.canvas.cards.forEach((c,i)=>Object.assign(c,{x:i*690,y:0,w:650,h:850}));
    await smokeApi('/api/projects/'+p.block_id,full.body);return p.block_id;
  })()`);
  await reopen(projectId);
  await wait("[...document.querySelectorAll('[data-card]')].every(c=>c.querySelectorAll('[data-history]').length>=2)");
  await js(`(()=>{
    for(const c of document.querySelectorAll('[data-card]')){
      const ids=[...c.querySelectorAll('[data-history]')].slice(0,2).map(b=>b.dataset.history);
      for(const id of ids){c.querySelector('[data-history="'+id+'"]').click();c.querySelector('.pin-current').click();}
    }
  })()`);
  await wait("document.querySelectorAll('.pinned-results img').length===2 && document.querySelectorAll('.pinned-results video').length===2");
  await wait("[...document.querySelectorAll('.pinned-results video')].every(v=>v.readyState>=2)");
  await js("window.docPins=[...document.querySelectorAll('.pinned-results video')];docPins.forEach(v=>{v.muted=true;v.loop=true;});document.querySelector('.sync-pins').click()");
  await wait('docPins.every(v=>!v.paused)');
  await js(`(()=>{for(const c of document.querySelectorAll('[data-card]')){
    c.querySelector('.history-details').open=false;
    const content=c.querySelector('.card-content'),target=c.querySelector('.pin-toolbar');
    content.scrollTop+=target.getBoundingClientRect().top-content.getBoundingClientRect().top;
  }})()`);
  await capture('pins-comparison.png');
  await js('docPins[0].pause()');
  await wait('docPins.every(v=>v.paused)');
  await js('docPins[0].currentTime=.2;docPins[0].playbackRate=1.25');
  await wait('Math.abs(docPins[1].currentTime-.2)<.1 && docPins[1].playbackRate===1.25');

  await js("document.querySelector('#back-dashboard').click()");
  await wait("!document.querySelector('#dashboard').hidden");
  await js("document.querySelector('#new-project').click();document.querySelector('#project-form').elements.title.value='本地与云端模型 · 按模型展示创作模式';document.querySelector('#project-form').requestSubmit()");
  await wait("!document.querySelector('#editor').hidden && !document.querySelector('#project-dialog').open");
  await js("document.querySelector('#add-image').click();document.querySelector('#add-image').click();document.querySelector('#add-image').click()");
  await js(`(()=>{
    const models=['z-image','si:dola-seedream-5-0-pro-260628','si:seedream-5-0-lite-260128'];
    for(const [i,c] of [...document.querySelectorAll('[data-card]')].entries()){
      const s=c.querySelector('[data-field=model]');s.value=models[i];s.dispatchEvent(new Event('change',{bubbles:true}));
      const p=c.querySelector('[data-field=prompt]');p.value='产品概念短片：比较不同模型的构图与创作方式';p.dispatchEvent(new Event('input',{bubbles:true}));
    }
  })()`);
  await wait("document.querySelector('#save-status').textContent.startsWith('已自动保存')");
  const modelProject = await js(`(async()=>{
    const p=(await smokeApi('/api/projects')).projects[0];
    const full=await smokeApi('/api/projects/'+p.block_id);
    full.body.canvas.cards.forEach((c,i)=>Object.assign(c,{x:i*470,y:0,w:440,h:850}));
    await smokeApi('/api/projects/'+p.block_id,full.body);return p.block_id;
  })()`);
  await reopen(modelProject);
  const modes = await js("[...document.querySelectorAll('[data-card]')].map(c=>[...c.querySelectorAll('[data-mode]')].map(t=>t.dataset.mode))");
  if (modes[0].join(',') !== 'text,image' || !modes[1].includes('edit') || modes[1].includes('series') || !modes[2].includes('series') || modes[2].includes('edit')) throw Error('Model-specific tabs do not match supported modes');
  await js(`(()=>{for(const c of document.querySelectorAll('[data-card]')){
    const content=c.querySelector('.card-content'),target=c.querySelector('.model-picker');
    content.scrollTop+=target.getBoundingClientRect().top-content.getBoundingClientRect().top;
  }})()`);
  await capture('model-guidance.png');
  console.log('README scenes verified: image PIN, synchronized video play/pause/seek/rate, model-specific tabs and local/cloud cards in one canvas.');
};
