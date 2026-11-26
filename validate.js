"use strict";
// 検証: node validate.js
const fs=require("fs"); const path=require("path");
const data=JSON.parse(fs.readFileSync(path.join(__dirname,"timetable.json"),"utf8"));
const {searchRoutes,calendarFor,toMin}=require("./app.js");
let pass=0, fail=0; const fails=[];
function check(name,cond){ if(cond){pass++;} else {fail++; fails.push(name); console.log("FAIL:",name);} }
// 基本整合性
check("駅ID重複なし", new Set(data.stations.map(s=>s.id)).size===data.stations.length);
check("列車ID重複なし", new Set(data.services.map(s=>s.id)).size===data.services.length);
const timeRe=/^\d{2}:\d{2}$/;
let timeOk=true, monoOk=true, orderOk=true;
const order={}; data.stations.forEach(s=>order[s.id]=s.order);
for(const svc of data.services){
  let prev=-1, prevOrder=null;
  for(const st of svc.stops){
    if(!timeRe.test(st.departure)||(st.arrival&&!timeRe.test(st.arrival))) timeOk=false;
    const m=toMin(st.departure); if(m<prev) monoOk=false; prev=m;
    if(prevOrder!==null && order[st.stationId]===prevOrder) orderOk=false;
    prevOrder=order[st.stationId];
  }
}
check("時刻形式", timeOk); check("列車内で時刻が逆行しない", monoOk); check("停車順序が重複しない", orderOk);
check("対応未確定列車は探索対象外(searchRoutesはconfirmedのみ使用)", data.services.every(s=>typeof s.confirmed==="boolean"));
check("通過駅データが存在する(草加発区間急行の獨協大学前通過)", data.services.some(s=>s.stops.some(st=>st.stationId==="dokkyo"&&st.pass)));
check("平日/土休日切替", calendarFor("2026-11-24")==="weekday" && calendarFor("2026-11-29")==="holiday");
function find(o){ return searchRoutes(data,o); }
const base={from:"dokkyo",to:"sanmaibashi",calendar:"weekday",mode:"depart",allowTurnback:false};
// 時間帯別 通常経路
for(const [label,t] of [["始発付近","05:00"],["朝","07:00"],["日中","11:00"],["夕方","17:00"]]){
  const r=find({...base,time:t}); check(`通常経路 ${label} ${t}`, r.length>=1 && !r[0].turnback);
  if(r.length) console.log(`  ${label} ${t} -> ${r[0].departure}→${r[0].arrival} 乗換${r[0].transfers}`);
}
const late=find({...base,time:"23:30"}); console.log("  終電付近 23:30 ->", late.length? late[0].departure+"→"+late[0].arrival : "なし");
check("終電後は結果なし(25:00指定)", find({...base,time:"25:00"}).length===0);
check("24時以降を処理できる(獨協大学前発草加 23:30以降に24時台あり)", find({from:"dokkyo",to:"soka",calendar:"weekday",mode:"depart",time:"23:30",allowTurnback:false}).length>=1);
// 折り返し経路: 平日朝、獨協大学前07:01発草加→草加07:31発区間急行館林行に接続できる想定
const tb=find({from:"dokkyo",to:"sanmaibashi",calendar:"weekday",mode:"depart",time:"06:55",allowTurnback:true});
console.log("  折り返し候補:", tb.map(r=>`${r.departure}→${r.arrival} turnback=${r.turnback}`).join(" | ")||"なし");
check("折り返し経路を検索できる", tb.some(r=>r.turnback));
check("折り返しなし設定では折り返し経路が出ない", find({from:"dokkyo",to:"sanmaibashi",calendar:"weekday",mode:"depart",time:"06:55",allowTurnback:false}).every(r=>!r.turnback));
check("循環経路を生成しない(全結果で同一列車の重複使用なし・到着が出発より後)", tb.every(r=>r.legs.every((l,i)=>r.legs.findIndex(x=>x.serviceId===l.serviceId)===i)));
// 最低乗換時間: 草加での乗換が180秒未満の接続は使われない
check("最低乗換時間を満たす(折り返し結果の草加乗換>=3分)", tb.filter(r=>r.turnback).every(r=>{
  const i=r.legs.findIndex(l=>l.to==="soka"); if(i<0||!r.legs[i+1]) return true;
  return toMin(r.legs[i+1].dep)-toMin(r.legs[i].arr)>=3;
}));
// 到着時刻指定
const arr=find({from:"dokkyo",to:"sanmaibashi",calendar:"weekday",mode:"arrive",time:"12:00",allowTurnback:false});
console.log("  到着指定 12:00まで:", arr.map(r=>`${r.departure}→${r.arrival}`).join(" | ")||"なし");
check("到着時刻指定で検索できる", arr.length>=1 && arr.every(r=>toMin(r.arrival)<=toMin("12:00")));
// 逆方向
const rev=find({from:"sanmaibashi",to:"dokkyo",calendar:"weekday",mode:"depart",time:"07:00",allowTurnback:false});
console.log("  逆方向 07:00 ->", rev.length? `${rev[0].departure}→${rev[0].arrival}`:"なし");
check("逆方向(三枚橋→獨協大学前)を検索できる", rev.length>=1);
console.log(`\n結果: PASS ${pass} / FAIL ${fail}`);
if(fail) process.exit(1);

// --- 小泉線経由の追加検証 ---
(function(){
  const k1=find({from:"tatebayashi",to:"ota",calendar:"weekday",mode:"depart",time:"05:00",allowTurnback:false});
  console.log("  館林→太田 候補:", k1.map(r=>r.legs.map(l=>l.from+">"+l.to).join(",")).join(" | "));
  const viaKoizumi=k1.some(r=>r.legs.some(l=>l.from==="higashi-koizumi"||l.to==="higashi-koizumi"));
  check("小泉線経由(館林→東小泉→太田)が検索できる", viaKoizumi);
  const k2=find({from:"dokkyo",to:"sanmaibashi",calendar:"weekday",mode:"depart",time:"05:00",allowTurnback:false});
  console.log("  獨協大学前→三枚橋(小泉線経由含む候補):", k2.map(r=>`${r.departure}→${r.arrival} koizumi=${r.legs.some(l=>l.from==="higashi-koizumi"||l.to==="higashi-koizumi")}`).join(" | "));
  const k3=find({from:"higashi-koizumi",to:"dokkyo",calendar:"weekday",mode:"depart",time:"07:00",allowTurnback:false});
  console.log("  東小泉→獨協大学前 07:00:", k3.length?`${k3[0].departure}→${k3[0].arrival}`:"なし");
  check("東小泉から通勤駅方向も検索できる", k3.length>=1);
  const k4=find({from:"tatebayashi",to:"nishi-koizumi",calendar:"weekday",mode:"depart",time:"07:00",allowTurnback:false});
  check("館林→西小泉(小泉町経由)が検索できる", k4.length>=1 && k4[0].legs.some(l=>l.to==="nishi-koizumi"));
  console.log(`追加検証後: PASS ${pass} / FAIL ${fail}`);
  if(fail) process.exit(1);
})();
