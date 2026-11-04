#!/usr/bin/env node
/**
 * Refresh public/ticks-snapshot.json supplies from on-chain TickRecord(s) via GraphQL.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'public', 'ticks-snapshot.json');
const GQL = process.env.SUI_GRAPHQL_URL || 'https://graphql.mainnet.sui.io/graphql';
const DEPLOY_TABLE =
  process.env.MOVES_DEPLOY_TABLE ||
  '0xbf93cd99f4f8e2663afdb8d9cdcb642ce3e171add2d88aa3f02c47294b052eeb';

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function gql(query, variables={}, tries=8){
  let last;
  for(let i=0;i<tries;i++){
    try{
      const res=await fetch(GQL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(45000)});
      if(res.status===429 || res.status>=500){ await sleep(Math.min(20000,400*2**i)); continue; }
      const json=await res.json();
      if(json.errors?.length){
        const msg=json.errors[0].message||'gql';
        if(/rate|429|thrott|capacity|timeout|limit/i.test(msg)){ await sleep(Math.min(20000,400*2**i)); continue; }
        throw new Error(msg);
      }
      return json.data;
    }catch(e){ last=e; await sleep(Math.min(10000,300*2**i)); }
  }
  throw last;
}

async function multiGet(ids){
  const q=`query($keys:[ObjectKey!]!){
    multiGetObjects(keys:$keys){
      address
      asMoveObject{ contents{ type{ repr } json } }
    }
  }`;
  const data=await gql(q,{keys: ids.map((address)=>({address}))});
  return data.multiGetObjects||[];
}

function parseRecord(tick, recordId, node, prev){
  const mo=node?.asMoveObject?.contents;
  if(!mo) return prev;
  const typ=mo?.type?.repr||'';
  const j=mo?.json||{};
  const isV2=typ.includes('TickRecordV2');
  let totalSupply=BigInt(j.total_supply??j.totalSupply??prev?.totalSupply??0);
  let currentSupply;
  let remain;
  let mintFee=prev?.mintFee??null;
  let startTimeMs=prev?.startTimeMs??null;
  let totalTx=prev?.totalTx??null;
  let mintFactory=prev?.mintFactory??null;
  if(isV2){
    const stat=j.stat||{};
    currentSupply=BigInt(stat.current_supply??stat.currentSupply??0);
    remain=BigInt(stat.remain?? (totalSupply-currentSupply));
    if(j.start_time_ms!=null) startTimeMs=Number(j.start_time_ms);
    if(stat.total_transactions!=null) totalTx=Number(stat.total_transactions);
    if(j.mint_factory) mintFactory=String(j.mint_factory);
  }else{
    currentSupply=BigInt(j.current_supply??j.currentSupply??0);
    remain=BigInt(j.remain?? (totalSupply-currentSupply));
    if(j.mint_fee!=null) mintFee=Number(j.mint_fee);
    if(j.start_time_ms!=null) startTimeMs=Number(j.start_time_ms);
    if(j.total_transactions!=null) totalTx=Number(j.total_transactions);
  }
  return {
    tick,
    recordId,
    isV2: Boolean(isV2 || prev?.isV2),
    totalSupply: Number(totalSupply),
    currentSupply: Number(currentSupply),
    remain: Number(remain < 0n ? 0n : remain),
    mintFee,
    startTimeMs,
    mintFactory: mintFactory || prev?.mintFactory || null,
    totalTx,
    marketId: prev?.marketId ?? null,
  };
}

async function discoverNewTicks(existing){
  // Walk DeployRecord table DFs for tick→recordId; add any missing.
  const q=`query($parent:SuiAddress!,$cursor:String){
    owner(address:$parent){
      dynamicFields(first:50, after:$cursor){
        pageInfo{hasNextPage endCursor}
        nodes{
          name{... on DynamicFieldNameString{value}}
          value{... on MoveObject{address asMoveObject{contents{json}}}}
        }
      }
    }
  }`;
  // Fallback simpler: dynamicFields on object
  const q2=`query($id:SuiAddress!,$cursor:String){
    object(address:$id){
      dynamicFields(first:50, after:$cursor){
        pageInfo{hasNextPage endCursor}
        nodes{
          name{ json }
          value{
            ... on MoveObject {
              address
              contents { json }
            }
          }
        }
      }
    }
  }`;
  let cursor=null; const found=[];
  try{
    for(;;){
      const data=await gql(q2,{id:DEPLOY_TABLE,cursor});
      const conn=data?.object?.dynamicFields;
      if(!conn) break;
      for(const n of conn.nodes||[]){
        const tick = typeof n.name?.json==='string' ? n.name.json : n.name?.json?.value || n.name?.json;
        const recordId = n.value?.address || n.value?.contents?.json?.value || n.value?.contents?.json;
        if(tick && typeof recordId==='string' && recordId.startsWith('0x') && !existing.has(tick)){
          found.push({tick:String(tick), recordId});
        }
      }
      if(!conn.pageInfo?.hasNextPage) break;
      cursor=conn.pageInfo.endCursor;
      await sleep(80);
    }
  }catch(e){
    console.warn('[discover] skip', e.message||e);
  }
  return found;
}

async function main(){
  if(!existsSync(OUT)) throw new Error('missing ticks-snapshot.json');
  const snap=JSON.parse(readFileSync(OUT,'utf8'));
  const byTick=new Map((snap.ticks||[]).map(t=>[t.tick,t]));
  // discover new
  const discovered=await discoverNewTicks(byTick);
  console.log('[refresh] discovered new', discovered.length);
  for(const d of discovered){
    byTick.set(d.tick, {tick:d.tick, recordId:d.recordId, isV2:true, totalSupply:0, currentSupply:0, remain:0, mintFee:null, startTimeMs:null, mintFactory:null, totalTx:null, marketId:null});
  }
  const ids=[...byTick.values()].map(t=>t.recordId).filter(Boolean);
  console.log('[refresh] ticks', byTick.size, 'records', ids.length);
  const updated=[];
  const byId=new Map([...byTick.values()].map(t=>[t.recordId,t]));
  for(let i=0;i<ids.length;i+=20){
    const batch=ids.slice(i,i+20);
    const nodes=await multiGet(batch);
    nodes.forEach((node, idx)=>{
      const recordId=batch[idx];
      const prev=byId.get(recordId);
      if(!prev) return;
      try{ updated.push(parseRecord(prev.tick, recordId, node, prev)); }
      catch(e){ console.warn('[refresh] parse fail', prev.tick, e.message||e); updated.push(prev); }
    });
    if((i/20)%5===0) console.log('[refresh] batch', i, '/', ids.length);
    await sleep(60);
  }
  const got=new Set(updated.map(t=>t.tick));
  for(const t of byTick.values()){ if(!got.has(t.tick)) updated.push(t); }
  updated.sort((a,b)=>String(a.tick).localeCompare(String(b.tick)));
  // tip
  let tip=null;
  try{
    const t=await gql(`query{ checkpoint { sequenceNumber timestamp } }`);
    tip=t.checkpoint;
  }catch{}
  const out={
    updatedAt: new Date().toISOString(),
    tipCheckpoint: tip?.sequenceNumber ?? null,
    tipTimestamp: tip?.timestamp ?? null,
    tipNote: 'supplies refreshed from TickRecord objects via GraphQL',
    ticks: updated,
  };
  writeFileSync(OUT, JSON.stringify(out));
  console.log('[refresh] DONE ticks', updated.length, 'updatedAt', out.updatedAt, 'tip', tip);
}
main().catch(e=>{ console.error(e); process.exit(1); });
