/* Three-way merge. Conflicting edits stay local and are never silently overwritten. */
(() => {
  const same=(a,b)=>{
    if(a===b)return true;
    if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
    const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&same(a[k],b[k]));
  };
  function merge(base,local,remote,path='') {
    if(same(local,base))return structuredClone(remote);
    if(same(remote,base)||same(local,remote))return structuredClone(local);
    if(path==='/canvas/viewport')return structuredClone(local);
    const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
    if(object(base)&&object(local)&&object(remote)){
      const result={};
      for(const key of new Set([...Object.keys(base),...Object.keys(local),...Object.keys(remote)])){
        if(path===''&&key==='revision'){result[key]=remote[key];continue;}
        const value=merge(base[key],local[key],remote[key],path+'/'+key);if(value!==undefined)result[key]=value;
      }return result;
    }
    if(Array.isArray(base)&&Array.isArray(local)&&Array.isArray(remote)&&[...base,...local,...remote].every(v=>object(v)&&v.id)){
      const b=new Map(base.map(v=>[v.id,v])),l=new Map(local.map(v=>[v.id,v])),r=new Map(remote.map(v=>[v.id,v]));
      const ids=v=>v.filter(x=>b.has(x.id)).map(x=>x.id);
      const orderChanged=v=>!same(ids(v),base.filter(x=>v.some(y=>y.id===x.id)).map(x=>x.id));
      if(orderChanged(local)&&orderChanged(remote)&&!same(ids(local),ids(remote)))throw Error('同一列表的排序已被其他窗口修改');
      const first=orderChanged(local)?local:remote,second=orderChanged(local)?remote:local;
      return [...new Set([...first,...second,...base].map(x=>x.id))].map(id=>merge(b.get(id),l.get(id),r.get(id),path+'/'+id)).filter(v=>v!==undefined);
    }
    throw Error('同一内容已被其他窗口修改，当前草稿已保留，请导出 JSON 后处理冲突');
  }
  if(typeof module!=='undefined')module.exports={merge,same};
  else window.directorLiveMerge={merge,same};
})();
