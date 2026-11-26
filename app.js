"use strict";
const MIN_TRANSFER = 180;
function toMin(t){ if(!t) return null; const p=t.split(":"); return (+p[0])*60+(+p[1]); }
function toStr(m){ return String(Math.floor(m/60)).padStart(2,"0")+":"+String(m%60).padStart(2,"0"); }
function calendarFor(dateStr){
  const d=new Date(dateStr+"T12:00:00+09:00"); const w=d.getDay();
  if(w===0) return "holiday"; if(w===6) return "saturday"; return "weekday";
}
function searchRoutes(data, opts){
  const {from,to,calendar,mode,time,allowTurnback}=opts;
  const stOrder={}; data.stations.forEach(s=>stOrder[s.id]=s.order);
  const services=data.services.filter(s=>s.calendar===calendar && s.confirmed);
  const byBoard={};
  services.forEach(svc=>{
    svc.stops.forEach((st,i)=>{
      if(st.pass) return;
      (byBoard[st.stationId]=byBoard[st.stationId]||[]).push({svc,idx:i});
    });
  });
  const target=toMin(time);
  const winStart = mode==="depart" ? target : Math.max(0, target-300);
  // 多ラベル(パレート)探索: 状態=駅|折返済|進行方向。到着・乗換・待ち・出発のどれかで劣るラベルだけを捨て、
  // 「少し遅く着くが乗換が少ない」「待ちが短い」等の別解を残すことで候補の多様性を確保する。
  const labels=new Map();
  const keyOf=l=>l.station+"|"+(l.turnUsed?1:0)+"|"+l.dir;
  const dom=(o,l)=> o.time<=l.time && o.transfers<=l.transfers && o.wait<=l.wait && (o.firstDep??-1)>=(l.firstDep??-1) && (!l.termHere || o.termHere);
  function addLabel(l){
    const k=keyOf(l); let arr=labels.get(k); if(!arr){ arr=[]; labels.set(k,arr); }
    if(arr.some(o=>dom(o,l))) return false;
    for(let i=arr.length-1;i>=0;i--) if(dom(l,arr[i])) arr.splice(i,1);
    if(arr.length>=120) return false;
    arr.push(l); return true;
  }
  // 二分ヒープ (time, transfers, wait) 順
  const heap=[];
  const less=(a,b)=> a.time!==b.time ? a.time<b.time : (a.transfers!==b.transfers ? a.transfers<b.transfers : a.wait<b.wait);
  function hpush(x){ heap.push(x); let i=heap.length-1; while(i>0){ const p=(i-1)>>1; if(!less(heap[i],heap[p])) break; [heap[i],heap[p]]=[heap[p],heap[i]]; i=p; } }
  function hpop(){ const top=heap[0], last=heap.pop(); if(heap.length){ heap[0]=last; let i=0; for(;;){ const l=2*i+1, r=l+1; let m=i; if(l<heap.length&&less(heap[l],heap[m])) m=l; if(r<heap.length&&less(heap[r],heap[m])) m=r; if(m===i) break; [heap[i],heap[m]]=[heap[m],heap[i]]; i=m; } } return top; }
  const start={station:from,time:winStart,transfers:0,wait:0,firstDep:null,turnUsed:false,dir:0,parent:null,leg:null,termHere:false};
  addLabel(start); hpush(start);
  const found=[]; let bestArr=Infinity, pops=0;
  while(heap.length){
    const cur=hpop();
    const arr=labels.get(keyOf(cur)); if(!arr || !arr.includes(cur)) continue; // 後に支配されて除去済み
    if(cur.station===to && cur.firstDep!==null){
      if(mode==="depart" || cur.time<=target){ found.push(cur); if(cur.time<bestArr) bestArr=cur.time; if(found.length>=60) break; }
      continue;
    }
    if(mode==="depart" && cur.time>bestArr+150) break;
    if(mode==="arrive" && cur.time>target) continue;
    if(++pops>60000) break;
    const boards=byBoard[cur.station]||[];
    for(const {svc,idx} of boards){
      const dep=toMin(svc.stops[idx].departure); if(dep===null) continue;
      let wait=0, transfers=cur.transfers;
      if(cur.firstDep===null){ if(dep<cur.time) continue; if(mode==="arrive" && dep>=target) continue; }
      else {
        // 必要乗換時間: 同方向への乗換は60秒、到着列車がその駅で終着し発車が2分以内なら接続列車として0秒、
        // 方向転換(折り返し等)は従来通り180秒(いずれも公式値が公表されていないための仮設定)
        const nxt=svc.stops[idx+1];
        const dirB=nxt ? Math.sign(stOrder[nxt.stationId]-stOrder[cur.station]) : 0;
        let need=MIN_TRANSFER;
        if(cur.dir!==0 && dirB===cur.dir) need=(cur.termHere && dep-cur.time<=2) ? 0 : 60;
        if(dep*60 < cur.time*60+need) continue;
        wait=dep-cur.time; transfers++;
      }
      for(let j=idx+1;j<svc.stops.length;j++){
        const st=svc.stops[j]; if(st.pass) continue;
        const arrT=toMin(st.arrival); if(arrT===null) continue;
        const dirSign=Math.sign(stOrder[st.stationId]-stOrder[cur.station]);
        let turnUsed=cur.turnUsed;
        if(cur.dir!==0 && dirSign!==cur.dir){
          if(cur.station!=="soka" || turnUsed || !allowTurnback) continue;
          turnUsed=true;
        }
        const leg={serviceId:svc.id,type:svc.type,destination:svc.destination,from:cur.station,to:st.stationId,dep:svc.stops[idx].departure,arr:st.arrival,depMin:dep,arrMin:arrT,estimated:svc.stops[idx].timeStatus==="estimated"||st.timeStatus==="estimated"};
        const nl={station:st.stationId,time:arrT,transfers,wait:cur.wait+wait,firstDep:cur.firstDep??dep,turnUsed,dir:dirSign,parent:cur,leg,termHere:svc.stops[svc.stops.length-1].stationId===st.stationId};
        if(addLabel(nl)) hpush(nl);
      }
    }
  }
  function toResult(l){
    const legs=[]; let c=l; while(c && c.leg){ legs.unshift(c.leg); c=c.parent; }
    let wait=0; for(let i=1;i<legs.length;i++) wait+=legs[i].depMin-legs[i-1].arrMin;
    return {departure:toStr(l.firstDep),arrival:toStr(l.time),duration:l.time-l.firstDep,transfers:legs.length?legs.length-1:0,turnback:l.turnUsed,wait,legs,estimated:legs.some(x=>x.estimated),firstDep:l.firstDep};
  }
  let results=found.map(toResult);
  const seen=new Set();
  results=results.filter(r=>{ const sig=r.legs.map(l=>l.serviceId+"@"+l.from+">"+l.to).join("|"); if(seen.has(sig)) return false; seen.add(sig); return true; });
  if(mode==="arrive") results=results.filter(r=>toMin(r.arrival)<=target);
  const rank=(a,b)=> (toMin(a.arrival)-toMin(b.arrival)) || (a.transfers-b.transfers) || (a.wait-b.wait) || (b.firstDep-a.firstDep) || ((a.turnback?1:0)-(b.turnback?1:0));
  if(mode==="depart") results.sort(rank);
  else results.sort((a,b)=> (b.firstDep-a.firstDep) || rank(a,b));
  return results.slice(0,10);
}
let DATA=null;
async function loadData(){
  // サーバー経由では timetable.json を優先し、file:// で直接開いた場合は埋め込みデータ(timetable.js)を使う
  try{ const r=await fetch("timetable.json"); if(r.ok) return await r.json(); }catch(e){}
  if(window.TIMETABLE_DATA) return window.TIMETABLE_DATA;
  throw new Error("timetable data not found");
}
if(typeof document!=="undefined"){
  document.addEventListener("DOMContentLoaded", async ()=>{
    const $=id=>document.getElementById(id);
    try{ DATA=await loadData(); }catch(e){ $("status").textContent="時刻表データを読み込めませんでした。index.html と同じフォルダに timetable.js があるか確認してください。"; return; }
    const fromSel=$("from"), toSel=$("to");
    DATA.stations.forEach(s=>{ fromSel.add(new Option(s.name,s.id)); toSel.add(new Option(s.name,s.id)); });
    fromSel.value="dokkyo"; toSel.value="sanmaibashi";
    const now=new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Tokyo"}));
    $("date").value=now.toISOString().slice(0,10);
    $("time").value=String(now.getHours()).padStart(2,"0")+":"+String(now.getMinutes()).padStart(2,"0");
    $("meta").textContent=`出典確認日 ${DATA.metadata.checkedDate} ／ ダイヤ施行日 ${DATA.metadata.revisionDate} ／ ${DATA.sources.map(s=>s.title).join("、")}`;
    $("swapBtn").addEventListener("click",()=>{ const v=fromSel.value; fromSel.value=toSel.value; toSel.value=v; });
    $("nowBtn").addEventListener("click",()=>{ const n=new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Tokyo"})); $("date").value=n.toISOString().slice(0,10); $("time").value=String(n.getHours()).padStart(2,"0")+":"+String(n.getMinutes()).padStart(2,"0"); $("mode").value="depart"; });
    $("searchBtn").addEventListener("click",()=>{
      const cal=calendarFor($("date").value||now.toISOString().slice(0,10));
      const allow=true;
      const res=searchRoutes(DATA,{from:fromSel.value,to:toSel.value,calendar:cal,mode:$("mode").value,time:$("time").value,allowTurnback:allow});
      const box=$("results"); box.innerHTML="";
      if(fromSel.value===toSel.value){ $("status").textContent="出発駅と到着駅が同じです。"; return; }
      if(!res.length){ $("status").textContent="該当する経路がありません。収録時間帯外、終電後、または接続列車が収録されていない可能性があります。"; return; }
      $("status").textContent=`${res.length}件見つかりました（${cal==="weekday"?"平日":"土休日"}ダイヤ）`;
      const normal=res.find(r=>!r.turnback);
      res.forEach((r,i)=>{
        const div=document.createElement("article"); div.className="card";
        const diff = (r.turnback && normal && normal!==r) ? `<p>通常経路との差: ${r.duration-normal.duration>0?"+":""}${r.duration-normal.duration}分</p>` : "";
        const legs=r.legs.map(l=>{
          const fn=DATA.stations.find(s=>s.id===l.from).name, tn=DATA.stations.find(s=>s.id===l.to).name;
          return `<li>${l.dep} ${fn} → ${l.arr} ${tn}（${l.type} ${l.destination}行）</li>`;
        }).join("");
        const waits=r.legs.slice(1).map((l,i)=>`${DATA.stations.find(s=>s.id===l.from).name}で乗換`).join("、");
        div.innerHTML=`<h3>${i+1}. ${r.departure} → ${r.arrival}（${r.duration}分） ${r.turnback?"【折り返し経路】":"【通常経路】"}</h3>
        <p>乗換 ${r.transfers}回 ／ 待ち時間合計 ${r.wait}分${waits?" ／ 乗換駅: "+waits:""}</p>${diff}
        <ul>${legs}</ul>`;
        box.appendChild(div);
      });
    });
  });
}
if(typeof module!=="undefined") module.exports={searchRoutes,calendarFor,toMin,toStr};
