require('dotenv').config();
const http = require('http');
const { Client, GatewayIntentBits } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 10000;
const NICOTINA_GUILD_ID = process.env.NICOTINA_GUILD_ID || '1481726829810159671';
const SCAN_CONCURRENCY = 5;
const SCAN_DEADLINE_MS = 20000;
const NITRO_GENERIC = 2; // premium_type "Nitro": tier exato exige scope de parceiro.

function readBody(req) { return new Promise((resolve,reject)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{try{resolve(JSON.parse(body))}catch{resolve({})}});req.on('error',reject);}); }
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) process.exit(1);
const supabase=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY);
const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildPresences,GatewayIntentBits.GuildMembers]});

function completedMonthsSince(value){if(!value)return 0;const start=value instanceof Date?value:new Date(value);if(Number.isNaN(start.getTime()))return 0;const now=new Date();let months=(now.getUTCFullYear()-start.getUTCFullYear())*12+now.getUTCMonth()-start.getUTCMonth();if(now.getUTCDate()<start.getUTCDate())months--;return Math.max(0,months);}
function normalizeSpotifyAsset(raw){if(!raw)return null;if(!raw.startsWith('spotify:'))return raw;const p=raw.split(':');return p[2]||p[1]?`https://i.scdn.co/image/${p[2]||p[1]}`:null;}
function serializePresence(presence){if(!presence)return null;let spotify=null;const activities=[];for(const a of presence.activities||[]){if(a.name==='Spotify'||a.type===2){spotify={title:a.details||'',artist:a.state||'',album:normalizeSpotifyAsset(a.assets?.largeImage||null),albumName:a.assets?.largeText||'',trackId:a.syncId||null,timestamps:a.timestamps?{start:a.timestamps.start?.getTime?.()??0,end:a.timestamps.end?.getTime?.()??0}:{start:0,end:0}};continue;}activities.push({id:a.id||a.name,name:a.name,details:a.details||'',state:a.state||'',type:a.type,application_id:a.applicationId||null,assets:a.assets?{large_image:a.assets.largeImage||null,large_text:a.assets.largeText||null,small_image:a.assets.smallImage||null,small_text:a.assets.smallText||null}:null,timestamps:a.timestamps?{start:a.timestamps.start?.getTime?.()??null,end:a.timestamps.end?.getTime?.()??null}:null});}return{status:presence.status||'offline',spotify,activities};}
async function getStoredPremiumMeta(id){const[{data:p},{data:s}]=await Promise.all([supabase.from('user_presence').select('nitro_type').eq('discord_id',id).maybeSingle(),supabase.from('social_profiles').select('premium_type, discord_nitro_months, discord_boost_months').eq('public_discord_id',id).maybeSingle()]);return{premiumType:Math.max(Number(p?.nitro_type||0),Number(s?.premium_type||0)),nitroMonths:Number(s?.discord_nitro_months||0),boostMonths:Number(s?.discord_boost_months||0)};}
async function upsertPresence(id,status,activities,spotify,flags,nitro){const{error}=await supabase.from('user_presence').upsert({discord_id:id,status,badges_bitfield:String(flags),nitro_type:Math.max(0,Number(nitro||0)),spotify,activities,updated_at:new Date().toISOString()},{onConflict:'discord_id'});if(error)console.error('[Presence]',error.message);}
async function syncProfileDiscordMeta(id,flags,premiumType,boostMonths,nitroMonths){try{const{error:rpcError}=await supabase.rpc('bot_sync_discord_badges',{p_discord_id:id,p_public_flags:String(flags||0),p_premium_type:Number(premiumType||0)});if(rpcError&&!rpcError.message?.includes('No rows'))console.error('[Profile flags]',rpcError.message);const patch={discord_boost_months:Math.max(0,Number(boostMonths||0))};if(Number(nitroMonths)>0)patch.discord_nitro_months=Math.floor(Number(nitroMonths));if(Number(premiumType)>0)patch.premium_type=Number(premiumType);const{error}=await supabase.from('social_profiles').update(patch).eq('public_discord_id',id);if(error)console.error('[Profile metadata]',error.message);}catch(e){console.error('[Profile sync]',e.message);}}
async function fetchDiscordJson(url,accessToken,{retryOn429=true}={}){try{const response=await fetch(url,{headers:{Authorization:`Bearer ${accessToken}`}});if(response.status===429&&retryOn429){const body=await response.json().catch(()=>({}));await new Promise(r=>setTimeout(r,Math.min(5000,Math.ceil(Number(body?.retry_after||1)*1000))));return fetchDiscordJson(url,accessToken,{retryOn429:false});}if(!response.ok){console.warn(`[OAuth] ${url}: HTTP ${response.status}`);return null;}const data=await response.json();return data&&typeof data==='object'?data:null;}catch(e){console.warn(`[OAuth] ${url}: ${e.message}`);return null;}}
async function validateOAuthIdentity(accessToken,expectedUserId){const me=await fetchDiscordJson('https://discord.com/api/v10/users/@me',accessToken);return me?.id&&String(me.id)===String(expectedUserId)?me:null;}

// premium_type (Nitro) exige o scope identify.premium, restrito a parceiros aprovados.
// Sem ele, resta inferir por recursos que so Nitro libera. Banner estatico virou
// gratuito em 2024, entao so contam: avatar/banner ANIMADO (prefixo a_) e avatar ou
// banner POR SERVIDOR, que continuam exclusivos de Nitro.
function detectNitroFromAssets(user){
  if(typeof user?.avatar==='string'&&user.avatar.startsWith('a_'))return 'avatar animado';
  if(typeof user?.banner==='string'&&user.banner.startsWith('a_'))return 'banner animado';
  return null;
}
function detectNitroFromMember(member){
  if(typeof member?.avatar==='string'&&member.avatar)return 'avatar por servidor';
  if(typeof member?.banner==='string'&&member.banner)return 'banner por servidor';
  return null;
}

// Uma unica varredura resolve os dois: premium_since prova o boost em qualquer
// servidor (nao so no /nicotina) e o membro traz os indicios de Nitro acima.
async function scanGuildsForPremium(accessToken){
  const guilds=await fetchDiscordJson('https://discord.com/api/v10/users/@me/guilds',accessToken);
  if(!Array.isArray(guilds)||guilds.length===0)return{boostMonths:null,nitroSource:null,scanned:0,total:0};
  const ids=guilds.map(g=>g?.id).filter(Boolean);
  const deadline=Date.now()+SCAN_DEADLINE_MS;
  let earliestBoost=null,nitroSource=null,cursor=0;
  const scan=async()=>{
    while(cursor<ids.length&&Date.now()<deadline){
      const member=await fetchDiscordJson(`https://discord.com/api/v10/users/@me/guilds/${ids[cursor++]}/member`,accessToken);
      const since=member?.premium_since?new Date(member.premium_since).getTime():NaN;
      if(!Number.isNaN(since)&&(earliestBoost===null||since<earliestBoost))earliestBoost=since;
      if(!nitroSource)nitroSource=detectNitroFromMember(member);
    }
  };
  await Promise.all(Array.from({length:Math.min(SCAN_CONCURRENCY,ids.length)},scan));
  return{boostMonths:earliestBoost===null?null:Math.max(1,completedMonthsSince(new Date(earliestBoost))),nitroSource,scanned:cursor,total:ids.length};
}

async function syncMember(member,{preserveWhenPresenceMissing=true,oauth=null}={}){if(!member||member.user?.bot)return null;const user=member.user;if(!user.flags&&typeof user.fetchFlags==='function')await user.fetchFlags().catch(()=>null);
  // force:true traz banner/avatar globais, que nao vem no objeto em cache.
  const fullUser=await user.fetch(true).catch(()=>user);
  const flags=BigInt(fullUser.flags?.bitfield??user.flags?.bitfield??0);const stored=await getStoredPremiumMeta(user.id);
  const nitroSource=detectNitroFromAssets({avatar:fullUser.avatar,banner:fullUser.banner})||detectNitroFromMember({avatar:member.avatar,banner:member.banner})||oauth?.nitroSource||null;
  const premiumType=nitroSource?NITRO_GENERIC:stored.premiumType;
  // Boost vale de qualquer servidor: o do /nicotina e o encontrado na varredura OAuth.
  const guildBoost=member.premiumSince?Math.max(1,completedMonthsSince(member.premiumSince)):0;
  const freshBoost=Math.max(guildBoost,Number(oauth?.boostMonths||0));
  const boostMonths=freshBoost>0?freshBoost:stored.boostMonths;
  const serialized=serializePresence(member.presence);if(serialized)await upsertPresence(user.id,serialized.status,serialized.activities,serialized.spotify,flags,premiumType);else if(!preserveWhenPresenceMissing)await upsertPresence(user.id,'offline',[],null,flags,premiumType);await syncProfileDiscordMeta(user.id,flags,premiumType,boostMonths,stored.nitroMonths);return{premiumType,nitroMonths:stored.nitroMonths,boostMonths,flags:String(flags),nitroSource};}
async function syncByDiscordId(userId,accessToken){if(!/^\d{17,20}$/.test(String(userId||'')))return{ok:false,status:400,error:'Discord ID inválido.'};if(!client.isReady())return{ok:false,status:503,error:'Bot ainda não está pronto.'};const guild=client.guilds.cache.get(NICOTINA_GUILD_ID);if(!guild)return{ok:false,status:503,error:'Servidor do nicotina.lol indisponível para o bot.'};const member=await guild.members.fetch({user:String(userId),force:true,withPresences:true}).catch(()=>null);if(!member)return{ok:false,status:404,error:'Sua conta Discord ainda não está no servidor do nicotina.lol.'};
  // O token e opcional: sem ele a sync continua valendo pelo que o bot ve na guild.
  let oauth=null;
  if(accessToken){
    if(!await validateOAuthIdentity(accessToken,userId))return{ok:false,status:401,error:'Autorização do Discord não pertence a esta conta.'};
    oauth=await scanGuildsForPremium(accessToken);
    console.log(`[Scan] ${userId}: ${oauth.scanned}/${oauth.total} guilds, boost=${oauth.boostMonths??'nenhum'}, nitro=${oauth.nitroSource??'nao detectado'}`);
  }
  const synced=await syncMember(member,{preserveWhenPresenceMissing:false,oauth});
  // total=0 com token significa que /users/@me/guilds falhou: quase sempre o token
  // foi emitido antes do scope guilds, entao o site precisa reautorizar.
  const scan=oauth?{guildsVisiveis:oauth.total,guildsVarridas:oauth.scanned,boostEncontrado:oauth.boostMonths,nitroEncontrado:oauth.nitroSource,escopoGuildsOk:oauth.total>0}:null;
  return{ok:true,status:200,synced,oauthUsed:Boolean(accessToken),scan};}

http.createServer(async(req,res)=>{res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type');if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,service:'nicotina-bot',discordReady:client.isReady()}));return;}if(req.method==='POST'&&req.url==='/sync'){const{userId,accessToken}=await readBody(req);try{const result=await syncByDiscordId(userId,accessToken);res.writeHead(result.status,{'Content-Type':'application/json'});res.end(JSON.stringify({success:result.ok,error:result.error,oauthUsed:result.oauthUsed,scan:result.scan,discordSync:result.synced||null}));}catch(e){console.error('[Sync]',e);res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Erro interno ao sincronizar Discord'}));}return;}res.writeHead(404);res.end();}).listen(PORT,'0.0.0.0',()=>console.log(`[WEB] porta ${PORT}`));

client.once('ready',async()=>{console.log(`[BOT] ONLINE: ${client.user.tag}`);for(const guild of client.guilds.cache.values()){try{const members=await guild.members.fetch({withPresences:true});for(const member of members.values())await syncMember(member);}catch(e){console.error('[INIT]',guild.name,e.message);}}});
client.on('presenceUpdate',async(_old,p)=>{if(p?.member&&!p.member.user?.bot)await syncMember(p.member,{preserveWhenPresenceMissing:false});});
client.on('guildMemberAdd',async m=>{if(!m.user?.bot)await syncMember(await m.guild.members.fetch({user:m.id,force:true,withPresences:true}).catch(()=>m));});
client.on('guildMemberUpdate',async(_old,m)=>{if(!m.user?.bot)await syncMember(m);});
client.on('error',e=>console.error('[ERRO BOT]',e));
if(!process.env.DISCORD_BOT_TOKEN){console.error('DISCORD_BOT_TOKEN ausente');process.exit(1);}client.login(process.env.DISCORD_BOT_TOKEN.trim());
