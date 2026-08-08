require('dotenv').config();
const http = require('http');
const { Client, GatewayIntentBits } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 10000;
const NICOTINA_GUILD_ID = process.env.NICOTINA_GUILD_ID || '1481726829810159671';

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausentes');
  process.exit(1);
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildPresences, GatewayIntentBits.GuildMembers] });

function completedMonthsSince(value) {
  if (!value) return 0;
  const start = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(start.getTime())) return 0;
  const now = new Date();
  let months = (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + now.getUTCMonth() - start.getUTCMonth();
  if (now.getUTCDate() < start.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

function normalizeSpotifyAsset(rawAlbumArt) {
  if (!rawAlbumArt) return null;
  if (!rawAlbumArt.startsWith('spotify:')) return rawAlbumArt;
  const parts = rawAlbumArt.split(':');
  const imageId = parts[2] || parts[1];
  return imageId ? `https://i.scdn.co/image/${imageId}` : null;
}

function serializePresence(presence) {
  if (!presence) return null;
  let spotify = null;
  const activities = [];
  for (const activity of presence.activities || []) {
    if (activity.name === 'Spotify' || activity.type === 2) {
      spotify = {
        title: activity.details || '', artist: activity.state || '',
        album: normalizeSpotifyAsset(activity.assets?.largeImage || null),
        albumName: activity.assets?.largeText || '', trackId: activity.syncId || null,
        timestamps: activity.timestamps ? { start: activity.timestamps.start?.getTime?.() ?? 0, end: activity.timestamps.end?.getTime?.() ?? 0 } : { start: 0, end: 0 },
      };
      continue;
    }
    activities.push({
      id: activity.id || activity.name, name: activity.name, details: activity.details || '', state: activity.state || '', type: activity.type,
      application_id: activity.applicationId || null,
      assets: activity.assets ? { large_image: activity.assets.largeImage || null, large_text: activity.assets.largeText || null, small_image: activity.assets.smallImage || null, small_text: activity.assets.smallText || null } : null,
      timestamps: activity.timestamps ? { start: activity.timestamps.start?.getTime?.() ?? null, end: activity.timestamps.end?.getTime?.() ?? null } : null,
    });
  }
  return { status: presence.status || 'offline', spotify, activities };
}

async function upsertPresence(discordId, status, activities, spotify, badgesBitfield, nitroType) {
  const { error } = await supabase.from('user_presence').upsert({
    discord_id: discordId, status, badges_bitfield: String(badgesBitfield), nitro_type: nitroType,
    spotify, activities, updated_at: new Date().toISOString(),
  }, { onConflict: 'discord_id' });
  if (error) console.error(`[Presence] ${discordId}:`, error.message);
}

async function syncProfileDiscordMeta(discordId, publicFlags, premiumType, boostMonths, nitroMonths) {
  if (!discordId) return;
  try {
    const { error: rpcError } = await supabase.rpc('bot_sync_discord_badges', {
      p_discord_id: discordId,
      p_public_flags: String(publicFlags || 0),
      p_premium_type: Number(premiumType || 0),
    });
    if (rpcError && !rpcError.message?.includes('No rows')) console.error(`[Profile flags] ${discordId}:`, rpcError.message);

    const patch = { discord_boost_months: Math.max(0, Number(boostMonths || 0)) };
    if (Number.isFinite(nitroMonths) && nitroMonths >= 0) patch.discord_nitro_months = Math.floor(nitroMonths);
    if (Number(premiumType || 0) > 0) patch.premium_type = Number(premiumType);

    const { error } = await supabase.from('social_profiles').update(patch).eq('public_discord_id', discordId);
    if (error) console.error(`[Profile metadata] ${discordId}:`, error.message);
  } catch (err) {
    console.error(`[Profile sync] ${discordId}:`, err.message);
  }
}

async function fetchOAuthProfile(accessToken) {
  if (!accessToken) return null;
  const headers = { Authorization: `Bearer ${accessToken}` };
  const endpoints = ['https://discord.com/api/v10/users/@me/profile', 'https://discord.com/api/v10/users/@me'];
  for (const url of endpoints) {
    try {
      const response = await fetch(url, { headers });
      if (!response.ok) continue;
      const data = await response.json();
      if (data && typeof data === 'object') return data;
    } catch (err) {
      console.warn(`[OAuth profile] ${url}: ${err.message}`);
    }
  }
  return null;
}

function extractNitroMeta(profile) {
  if (!profile) return { premiumType: 0, nitroMonths: null };
  const premiumType = Number(profile.premium_type ?? profile.user?.premium_type ?? 0);
  const since = profile.premium_since ?? profile.premium_subscription_since ?? profile.user?.premium_since ?? null;
  return { premiumType, nitroMonths: since ? completedMonthsSince(since) : null };
}

async function syncMember(member, { preserveWhenPresenceMissing = true, oauthMeta = null } = {}) {
  if (!member || member.user?.bot) return;
  const user = member.user;
  if (!user.flags && typeof user.fetchFlags === 'function') await user.fetchFlags().catch(() => null);
  const badgesBitfield = BigInt(user.flags?.bitfield ?? 0);
  const premiumType = Number(oauthMeta?.premiumType || 0);
  const boostMonths = member.premiumSince ? completedMonthsSince(member.premiumSince) : 0;
  const serialized = serializePresence(member.presence);

  if (serialized) await upsertPresence(user.id, serialized.status, serialized.activities, serialized.spotify, badgesBitfield, premiumType);
  else if (!preserveWhenPresenceMissing) await upsertPresence(user.id, 'offline', [], null, badgesBitfield, premiumType);

  await syncProfileDiscordMeta(user.id, badgesBitfield, premiumType, boostMonths, oauthMeta?.nitroMonths ?? null);
}

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'nicotina-bot', discordReady: client.isReady() }));
    return;
  }

  if (req.method === 'POST' && req.url === '/join') {
    const { accessToken, userId } = await readBody(req);
    if (!accessToken || !userId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'accessToken e userId são necessários' }));
      return;
    }
    try {
      const oauthProfile = await fetchOAuthProfile(accessToken);
      const oauthMeta = extractNitroMeta(oauthProfile);
      const response = await fetch(`https://discord.com/api/v10/guilds/${NICOTINA_GUILD_ID}/members/${userId}`, {
        method: 'PUT',
        headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: accessToken }),
      });
      if (response.status === 201 || response.status === 204) {
        const guild = client.guilds.cache.get(NICOTINA_GUILD_ID);
        if (guild) {
          const fetched = await guild.members.fetch({ user: userId, force: true, withPresences: true }).catch(() => null);
          if (fetched) await syncMember(fetched, { oauthMeta });
        }
        res.writeHead(response.status === 201 ? 201 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, discordSync: { boost: true, nitro: oauthMeta.nitroMonths !== null } }));
      } else {
        const errorData = await response.json().catch(() => ({}));
        res.writeHead(response.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: errorData }));
      }
    } catch (err) {
      console.error('[Join]', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Erro interno no servidor do bot' }));
    }
    return;
  }
  res.writeHead(404); res.end();
}).listen(PORT, '0.0.0.0', () => console.log(`[WEB] porta ${PORT}`));

client.once('ready', async () => {
  console.log(`[BOT] ONLINE: ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) {
    try {
      const members = await guild.members.fetch({ withPresences: true });
      for (const member of members.values()) await syncMember(member);
    } catch (err) { console.error(`[INIT] ${guild.name}:`, err.message); }
  }
});
client.on('presenceUpdate', async (_oldPresence, newPresence) => {
  if (!newPresence?.member || newPresence.member.user?.bot) return;
  await syncMember(newPresence.member, { preserveWhenPresenceMissing: false });
});
client.on('guildMemberAdd', async member => {
  if (member.user?.bot) return;
  const fetched = await member.guild.members.fetch({ user: member.id, force: true, withPresences: true }).catch(() => member);
  await syncMember(fetched);
});
client.on('guildMemberUpdate', async (_oldMember, newMember) => { if (!newMember.user?.bot) await syncMember(newMember); });
client.on('error', e => console.error('[ERRO BOT]', e));
if (!process.env.DISCORD_BOT_TOKEN) { console.error('DISCORD_BOT_TOKEN ausente'); process.exit(1); }
client.login(process.env.DISCORD_BOT_TOKEN.trim());
