require('dotenv').config();
const http = require('http');
const { Client, GatewayIntentBits } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 10000;
const NICOTINA_GUILD_ID = process.env.NICOTINA_GUILD_ID || '1481726829810159671';
const SCAN_SPACING_MS = 350;
const SCAN_DEADLINE_MS = 45000;

const DISCORD_BADGE_FLAGS = [
  { bit: 0, key: 'staff', label: 'Discord Staff' },
  { bit: 1, key: 'partner', label: 'Partnered Server Owner' },
  { bit: 2, key: 'hypesquad_events', label: 'HypeSquad Events' },
  { bit: 3, key: 'bug_hunter_1', label: 'Discord Bug Hunter' },
  { bit: 6, key: 'hypesquad_bravery', label: 'HypeSquad Bravery' },
  { bit: 7, key: 'hypesquad_brilliance', label: 'HypeSquad Brilliance' },
  { bit: 8, key: 'hypesquad_balance', label: 'HypeSquad Balance' },
  { bit: 9, key: 'early_supporter', label: 'Early Supporter' },
  { bit: 14, key: 'bug_hunter_2', label: 'Discord Bug Hunter Level 2' },
  { bit: 17, key: 'early_verified_developer', label: 'Early Verified Bot Developer' },
  { bit: 18, key: 'certified_moderator', label: 'Moderator Programs Alumni' },
  { bit: 22, key: 'active_developer', label: 'Active Developer' },
];

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) process.exit(1);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildPresences, GatewayIntentBits.GuildMembers] });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on('error', reject);
  });
}
function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
function completedMonthsSince(value) {
  if (!value) return 0;
  const start = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(start.getTime())) return 0;
  const now = new Date();
  let months = (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + now.getUTCMonth() - start.getUTCMonth();
  if (now.getUTCDate() < start.getUTCDate()) months--;
  return Math.max(0, months);
}
function normalizeSpotifyAsset(raw) {
  if (!raw || !raw.startsWith('spotify:')) return raw || null;
  const p = raw.split(':');
  return p[2] || p[1] ? `https://i.scdn.co/image/${p[2] || p[1]}` : null;
}
function serializePresence(presence) {
  if (!presence) return null;
  let spotify = null;
  const activities = [];
  for (const a of presence.activities || []) {
    if (a.name === 'Spotify' || a.type === 2) {
      spotify = { title: a.details || '', artist: a.state || '', album: normalizeSpotifyAsset(a.assets?.largeImage || null), albumName: a.assets?.largeText || '', trackId: a.syncId || null, timestamps: { start: a.timestamps?.start?.getTime?.() ?? 0, end: a.timestamps?.end?.getTime?.() ?? 0 } };
      continue;
    }
    activities.push({ id: a.id || a.name, name: a.name, details: a.details || '', state: a.state || '', type: a.type, application_id: a.applicationId || null, assets: a.assets ? { large_image: a.assets.largeImage || null, large_text: a.assets.largeText || null, small_image: a.assets.smallImage || null, small_text: a.assets.smallText || null } : null, timestamps: a.timestamps ? { start: a.timestamps.start?.getTime?.() ?? null, end: a.timestamps.end?.getTime?.() ?? null } : null });
  }
  return { status: presence.status || 'offline', spotify, activities };
}
async function getStoredPremiumMeta(id) {
  const [{ data: p }, { data: s }] = await Promise.all([
    supabase.from('user_presence').select('nitro_type,badges_bitfield').eq('discord_id', id).maybeSingle(),
    supabase.from('social_profiles').select('premium_type,discord_nitro_months,discord_boost_months,discord_boost_since,public_flags').eq('public_discord_id', id).maybeSingle(),
  ]);
  return { premiumType: Math.max(Number(p?.nitro_type || 0), Number(s?.premium_type || 0)), nitroMonths: Number(s?.discord_nitro_months || 0), boostMonths: Number(s?.discord_boost_months || 0), boostSince: s?.discord_boost_since || null, flags: String(s?.public_flags ?? p?.badges_bitfield ?? '0') };
}
async function upsertPresence(id, status, activities, spotify, flags, nitro) {
  const { error } = await supabase.from('user_presence').upsert({ discord_id: id, status, badges_bitfield: String(flags), nitro_type: Math.max(0, Number(nitro || 0)), spotify, activities, updated_at: new Date().toISOString() }, { onConflict: 'discord_id' });
  if (error) console.error('[Presence]', error.message);
}
async function syncProfileDiscordMeta(id, flags, premiumType, boostMonths, nitroMonths, boostSince, premiumAuthoritative = false) {
  try {
    const params = {
      p_discord_id: id,
      p_public_flags: String(flags || 0),
      p_premium_type: Number(premiumType || 0),
      p_nitro_months: Math.max(0, Math.floor(Number(nitroMonths || 0))),
      p_boost_months: Math.max(0, Math.floor(Number(boostMonths || 0))),
      p_boost_since: boostSince || null,
      p_premium_authoritative: Boolean(premiumAuthoritative),
    };
    const { error: rpcError } = await supabase.rpc('bot_sync_discord_badges', params);
    if (rpcError && !rpcError.message?.includes('No rows')) console.error('[Profile flags]', rpcError.message);
  } catch (e) { console.error('[Profile sync]', e.message); }
}
async function fetchDiscordJson(url, accessToken, retries = 4) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (response.status === 429) {
        const body = await response.json().catch(() => ({}));
        if (body?.global || attempt === retries) return null;
        await sleep(Math.min(10000, Math.ceil(Number(body?.retry_after || 1) * 1000) + 250));
        continue;
      }
      if (!response.ok) return null;
      const data = await response.json();
      return data && typeof data === 'object' ? data : null;
    } catch { if (attempt === retries) return null; await sleep(500); }
  }
  return null;
}
async function validateOAuthIdentity(accessToken, expectedUserId) {
  const me = await fetchDiscordJson('https://discord.com/api/v10/users/@me', accessToken);
  return me?.id && String(me.id) === String(expectedUserId) ? me : null;
}
async function getOAuthIdentity(accessToken, expectedUserId) {
  const [me, authorization] = await Promise.all([
    fetchDiscordJson('https://discord.com/api/v10/users/@me', accessToken),
    fetchDiscordJson('https://discord.com/api/v10/oauth2/@me', accessToken),
  ]);
  if (!me?.id || String(me.id) !== String(expectedUserId)) return null;
  const scopes = Array.isArray(authorization?.scopes) ? authorization.scopes : [];
  const premiumAuthoritative = scopes.includes('identify.premium');
  return {
    user: me,
    premiumAuthoritative,
    premiumType: premiumAuthoritative ? Math.max(0, Number(me.premium_type || 0)) : null,
  };
}
async function syncMember(member, { preserveWhenPresenceMissing = true, oauth = null } = {}) {
  if (!member || member.user?.bot) return null;
  const user = member.user;
  if (!user.flags && typeof user.fetchFlags === 'function') await user.fetchFlags().catch(() => null);
  const fullUser = await user.fetch(true).catch(() => user);
  const flags = BigInt(fullUser.flags?.bitfield ?? user.flags?.bitfield ?? 0);
  const stored = await getStoredPremiumMeta(user.id);
  const premiumAuthoritative = Boolean(oauth?.premiumAuthoritative);
  const premiumType = premiumAuthoritative ? Number(oauth.premiumType || 0) : stored.premiumType;
  const boostSince = member.premiumSince ? member.premiumSince.toISOString() : null;
  const boostMonths = boostSince ? Math.max(1, completedMonthsSince(boostSince)) : 0;
  const serialized = serializePresence(member.presence);
  if (serialized) await upsertPresence(user.id, serialized.status, serialized.activities, serialized.spotify, flags, premiumType);
  else if (!preserveWhenPresenceMissing) await upsertPresence(user.id, 'offline', [], null, flags, premiumType);
  await syncProfileDiscordMeta(user.id, flags, premiumType, boostMonths, stored.nitroMonths, boostSince, premiumAuthoritative);
  return { premiumType, nitroMonths: stored.nitroMonths, boostMonths, boostSince, flags: String(flags), premiumAuthoritative };
}
async function syncByDiscordId(userId, accessToken) {
  if (!/^\d{17,20}$/.test(String(userId || ''))) return { ok: false, status: 400, error: 'Discord ID inválido.' };
  if (!client.isReady()) return { ok: false, status: 503, error: 'Bot ainda não está pronto.' };
  const guild = client.guilds.cache.get(NICOTINA_GUILD_ID);
  if (!guild) return { ok: false, status: 503, error: 'Servidor do nicotina.lol indisponível para o bot.' };
  const member = await guild.members.fetch({ user: String(userId), force: true, withPresences: true }).catch(() => null);
  if (!member) return { ok: false, status: 404, error: 'Sua conta Discord ainda não está no servidor do nicotina.lol.' };
  let oauth = null;
  if (accessToken) {
    oauth = await getOAuthIdentity(accessToken, userId);
    if (!oauth) return { ok: false, status: 401, error: 'Autorização do Discord não pertence a esta conta.' };
  }
  const synced = await syncMember(member, { preserveWhenPresenceMissing: false, oauth });
  return {
    ok: true,
    status: 200,
    synced,
    oauthUsed: Boolean(accessToken),
    nitroAvailable: Boolean(oauth?.premiumAuthoritative),
  };
}
function boosterStage(months) {
  const m = Math.max(0, Number(months || 0));
  if (m >= 24) return 9; if (m >= 18) return 8; if (m >= 15) return 7; if (m >= 12) return 6; if (m >= 9) return 5; if (m >= 6) return 4; if (m >= 3) return 3; if (m >= 2) return 2; if (m > 0) return 1; return 0;
}
function flagsToBadges(flagsValue) {
  let flags = 0n;
  try { flags = BigInt(String(flagsValue || '0')); } catch {}
  return DISCORD_BADGE_FLAGS.filter(b => (flags & (1n << BigInt(b.bit))) !== 0n).map(b => ({ key: b.key, label: b.label, source: 'discord_public_flags' }));
}
async function getNormalizedDiscordBadges(userId) {
  const stored = await getStoredPremiumMeta(userId);
  const badges = flagsToBadges(stored.flags);
  if (stored.premiumType > 0) badges.push({ key: stored.premiumType === 3 ? 'nitro_basic' : 'nitro', label: stored.premiumType === 3 ? 'Discord Nitro Basic' : 'Discord Nitro', premiumType: stored.premiumType, months: stored.nitroMonths, source: stored.premiumType === NITRO_GENERIC ? 'inferred' : 'discord_oauth' });
  if (stored.boostMonths > 0) badges.push({ key: 'server_booster', label: 'Server Booster', months: stored.boostMonths, stage: boosterStage(stored.boostMonths), source: 'discord_guild_membership' });
  return { userId: String(userId), badges, meta: stored };
}

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET' && req.url === '/') { sendJson(res, 200, { ok: true, service: 'nicotina-bot', discordReady: client.isReady(), badgeApi: 1 }); return; }
  if (req.method === 'POST' && req.url === '/sync') {
    const { userId, accessToken } = await readBody(req);
    try { const result = await syncByDiscordId(userId, accessToken); sendJson(res, result.status, { success: result.ok, error: result.error, oauthUsed: result.oauthUsed, nitroAvailable: result.nitroAvailable, discordSync: result.synced || null }); }
    catch (e) { console.error('[Sync]', e); sendJson(res, 500, { error: 'Erro interno ao sincronizar Discord' }); }
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/discord-badges')) {
    try {
      const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const userId = parsed.searchParams.get('userId');
      if (!/^\d{17,20}$/.test(String(userId || ''))) { sendJson(res, 400, { success: false, error: 'Discord ID inválido.' }); return; }
      sendJson(res, 200, { success: true, ...(await getNormalizedDiscordBadges(userId)) });
    } catch (e) { console.error('[Badge API]', e); sendJson(res, 500, { success: false, error: 'Erro interno ao carregar badges.' }); }
    return;
  }
  res.writeHead(404); res.end();
}).listen(PORT, '0.0.0.0', () => console.log(`[WEB] porta ${PORT}`));

client.once('ready', async () => {
  console.log(`[BOT] ONLINE: ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) {
    try { const members = await guild.members.fetch({ withPresences: true }); for (const member of members.values()) await syncMember(member); }
    catch (e) { console.error('[INIT]', guild.name, e.message); }
  }
});
client.on('presenceUpdate', async (_old, p) => { if (p?.member && !p.member.user?.bot) await syncMember(p.member, { preserveWhenPresenceMissing: false }); });
client.on('guildMemberAdd', async m => { if (!m.user?.bot) await syncMember(await m.guild.members.fetch({ user: m.id, force: true, withPresences: true }).catch(() => m)); });
client.on('guildMemberUpdate', async (_old, m) => { if (!m.user?.bot) await syncMember(m); });
client.on('error', e => console.error('[ERRO BOT]', e));
if (!process.env.DISCORD_BOT_TOKEN) { console.error('DISCORD_BOT_TOKEN ausente'); process.exit(1); }
client.login(process.env.DISCORD_BOT_TOKEN.trim());
