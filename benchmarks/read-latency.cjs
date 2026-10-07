// Read-only, entirely mocked RPC benchmark. Executes the installed SDK and its
// viem auto-multicall implementation in memory; never contacts a provider.
// Build first: npm run build
// Run: node benchmarks/read-latency.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {createRequire} = require('node:module');
const {createHash} = require('node:crypto');
const { resolve } = require('node:path');
const root = resolve(__dirname, '..');
const entry = fs.realpathSync(root + '/dist/index.cjs');
const req = createRequire(entry);
const viem = req('viem');
const source = fs.readFileSync(entry, 'utf8');
const original = `    const poolData = await this.getPoolData();
    const rateRes = await this.price.getRateRes();
    const oraclePrice = await this.price.getOraclePrice();
`;
const methodStart = source.indexOf('  async getPoolInfo() {');
const readsStart = source.indexOf('    const observe = ', methodStart);
const quotesStart = source.indexOf('    const buyPrice = ', methodStart);
assert.ok(readsStart > methodStart && quotesStart > readsStart, 'install the safe view-read patch before benchmarking');
const concurrentReads = source.slice(readsStart, quotesStart);
function load(parallelize) {
  // Both variants use the corrected multicall timing. This isolates the
  // view-read scheduling change from the separate trailing-delay fix.
  let text = source;
  if (!parallelize) text = text.replace(concurrentReads, original);
  text += '\nexports._inspect = {Pool, FxSdk, tokens, setClient: (client) => { getClient = () => client; }, ERC20_default, AFPool_default, PoolManager_default, ShortPoolManager_default, PoolConfiguration_default, RateProvider_default, PriceOracle_default, MultiPathConverter_default};';
  const module = {exports:{}};
  new Function('require','module','exports','console',text)(req, module, module.exports, {...console, log: () => {}});
  return module.exports._inspect;
}
function plainDefault(type) {
  if(type.startsWith('uint') || type.startsWith('int')) return 1000000000000000000000n;
  if(type==='bool') return false;
  if(type==='address') return '0x1111111111111111111111111111111111111111';
  throw Error('unhandled type ' + type);
}
async function run(parallelize, poolName, operation = 'getPoolInfo') {
 const sdk=load(parallelize);
 const abis=[viem.multicall3Abi,...Object.entries(sdk).filter(([k])=>k.endsWith('_default')).map(([,v])=>v)];
 const rpc=[]; const logical=[]; const t0=performance.now();
 function reply(data, target) {
  for(const abi of abis) {
   let decoded; try { decoded=viem.decodeFunctionData({abi,data}); } catch { continue; }
   const name=decoded.functionName;
   if(name==='aggregate3') return viem.encodeFunctionResult({abi,functionName:name,result:decoded.args[0].map(call=>({success:true,returnData:reply(call.callData, call.target)}))});
   logical.push({target,name,args:decoded.args});
   const fn=abi.find(i=>i.type==='function' && i.name===name);
   let result;
   if(name==='getDebtRatioRange') result=[100000000000000000n,900000000000000000n];
   else if(name==='getPoolFeeRatio') result=[1000000n,2000000n,3000000n,4000000n];
   else if(name==='getRate') result=1200000000000000000n;
   else if(name==='getPrice') result=[2000000000000000000000n,1990000000000000000000n,2010000000000000000000n];
   else if(name==='queryConvert') result=BigInt(decoded.args[0])*2n;
   else { const out=fn.outputs.map(o=>plainDefault(o.type)); result=out.length===1?out[0]:out; }
   return viem.encodeFunctionResult({abi,functionName:name,result});
  }
  throw Error('unknown calldata ' + data.slice(0,10));
 }
 sdk.setClient(viem.createPublicClient({
  batch: { multicall: true }, chain: req('viem/chains').mainnet,
  transport: viem.custom({request:async ({method,params})=>{
   if(method==='eth_getTransactionCount') return '0x0';
   assert.equal(method,'eth_call','no network or writes permitted');
   const item={at:Math.round(performance.now()-t0),selector:params[0].data.slice(0,10)}; rpc.push(item);
   await new Promise(r=>setTimeout(r,100));
   const before=logical.length; const out=reply(params[0].data, params[0].to); item.logical=logical.length-before; item.reads=logical.slice(before);
   return out;
 }},{retryCount:0}) }));
 const market=poolName.includes('WBTC')?'BTC':'ETH'; const client=new sdk.FxSdk();
 const value = operation === 'getPoolInfo'
   ? await new sdk.Pool({poolName}).getPoolInfo()
   : await client.depositAndMint({market,positionId:0,userAddress:'0x1111111111111111111111111111111111111111',depositTokenAddress:market==='ETH'?sdk.tokens.wstETH:sdk.tokens.WBTC,depositAmount:market==='ETH'?10n**18n:10n**8n,mintAmount:100n*10n**18n});
 return {value,ms:Math.round(performance.now()-t0),rpc,logical};
}
function canonicalJson(value) {
 return JSON.stringify(value, (_, item) => typeof item === 'bigint'
  ? { bigint: item.toString() }
  : item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
    : item);
}
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length / 2)];
(async()=>{
 const repetitions = 5;
 console.log(JSON.stringify({runtime:process.version,repetitions,fixedRpcDelayMs:100,sourceSha256:createHash('sha256').update(source).digest('hex'),profile:'safe-view-reads-only',excludedFinalMulticallDelay:true}));
 for(const [operation,pool] of [['getPoolInfo','wstETH'],['getPoolInfo','WBTC'],['getPoolInfo','wstETH_short'],['getPoolInfo','WBTC_short'],['depositAndMint','wstETH'],['depositAndMint','WBTC']]) {
  const samples=[];
  let resultHash;
  for(let sample=0;sample<repetitions;sample++) {
   // Alternate which variant goes first to reduce warm-up/order bias.
   const first=await run(sample % 2 !== 0,pool,operation),second=await run(sample % 2 === 0,pool,operation);
   const serial=sample % 2 === 0 ? first : second,parallel=sample % 2 === 0 ? second : first;
   assert.deepEqual(parallel.value,serial.value);
   assert.deepEqual(parallel.logical.map(canonicalJson).sort(),serial.logical.map(canonicalJson).sort());
   const quoteBatches = result => result.rpc.filter(request => request.reads.some(read => read.name === 'queryConvert')).map(request => request.reads);
   assert.deepEqual(quoteBatches(parallel), quoteBatches(serial), 'converter calls must preserve their original batch grouping');
   for (const request of parallel.rpc) if (request.reads.some(read => read.name === 'queryConvert')) assert.ok(request.reads.every(read => read.name === 'queryConvert'));
   for (const result of [serial,parallel]) for (const request of result.rpc) request.reads = request.reads.map(read => read.name);
   const serialHash=hash(serial.value),parallelHash=hash(parallel.value);
   assert.equal(parallelHash,serialHash);
   if(resultHash)assert.equal(serialHash,resultHash,'static fixture must produce the same result on every run');
   resultHash=serialHash;
   samples.push({serialMs:serial.ms,parallelMs:parallel.ms,logicalReads:serial.logical.length,serialRequests:serial.rpc,parallelRequests:parallel.rpc});
  }
  const serialMedianMs=median(samples.map(s=>s.serialMs)),parallelMedianMs=median(samples.map(s=>s.parallelMs));
  console.log(JSON.stringify({operation,pool,profile:'safe-view-reads-only',repetitions,fixedRpcDelayMs:100,excludedFinalMulticallDelay:true,serialMedianMs,parallelMedianMs,savedMedianMs:serialMedianMs-parallelMedianMs,serialResultSha256:resultHash,parallelResultSha256:resultHash,identicalCompleteResult:true,identicalLogicalReads:true,samples}));
 }
})().catch(e=>{console.error(e);process.exitCode=1});
