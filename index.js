require('dotenv').config();
const crypto = require('crypto');
const http = require('http');
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 10000;
const NICOTINA_GUILD_ID = process.env.NICOTINA_GUILD_ID || '1481726829810159671';
const SCAN_CONCURRENCY = 1;
const SCAN_SPACING_MS = 350;
const SCAN_DEADLINE_MS = 45000;
const NITRO_GENERIC = 2;
const NITRO_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const NITRO_RESULT_TTL_MS = 10 * 60 * 1000;

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) process.exit(1);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// challengeToken -> challenge. O token aleatorio evita expor/pollar por Discord ID.
const nitroChallenges = new Map();
const nitroChallengeByUser = new Map();

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
  if (!raw) return null;
  if (!raw.startsWith('spotify:')) return raw;
  const p = raw.split(':');
  return p[2] || p[1] ? `https://i.scdn.co/image/${p[2] || p[1]}` : null;
}

function serializePresence(presence) {
  if (!presence) return null;
  let spotify = null;
  const activities = [];
  for (const a of presence.activities || []) {
    if (a.name === 'Spotify' || a.type === 2) {
      spotify = {
        title: a.details || '',
        artist: a.state || '',
        album: normalizeSpotifyAsset(a.assets?.largeImage || null),
        albumName: a.assets?.largeText || '',
        trackId: a.syncId || null,
        timestamps: a.timestamps ? {
          start: a.timestamps.start?.getTime?.() ?? 0,
          end: a.timestamps.end?.getTime?.() ?? 0,
        } : { start: 0, end: 0 },
      };
      continue;
    }
    activities.push({
      id: a.id || a.name,
      name: a.name,
      details: a.details || '',
      state: a.state || '',
      type: a.type,
      application_id: a.applicationId || null,
      assets: a.assets ? {
        large_image: a.assets.largeImage || null,
        large_text: a.assets.largeText || null,
        small_image: a.assets.smallImage || null,
        small_text: a.assets.smallText || null,
      } : null,
      timestamps: a.timestamps ? {
        start: a.timestamps.start?.getTime?.() ?? null,
        end: a.timestamps.end?.getTime?.() ?? null,
      } : null,
    });
  }
  return { status: presence.status || 'offline', spotify, activities };
}

async function getStoredPremiumMeta(id) {
  const [{ data: p }, { data: s }] = await Promise.all([
    supabase.from('user_presence').select('nitro_type,badges_bitfield').eq('discord_id', id).maybeSingle(),
    supabase.from('social_profiles').select('premium_type,discord_nitro_months,discord_boost_months,discord_public_flags').eq('public_discord_id', id).maybeSingle(),
  ]);
  return {
    premiumType: Math.max(Number(p?.nitro_type || 0), Number(s?.premium_type || 0)),
    nitroMonths: Number(s?.discord_nitro_months || 0),
    boostMonths: Number(s?.discord_boost_months || 0),
    flags: String(s?.discord_public_flags ?? p?.badges_bitfield ?? '0'),
  };
}

async function upsertPresence(id, status, activities, spotify, flags, nitro) {
  const { error } = await supabase.from('user_presence').upsert({
    discord_id: id,
    status,
    badges_bitfield: String(flags),
    nitro_type: Math.max(0, Number(nitro || 0)),
    spotify,
    activities,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'discord_id' });
  if (error) console.error('[Presence]', error.message);
}

async function syncProfileDiscordMeta(id, flags, premiumType, boostMonths, nitroMonths) {
  try {
    const { error: rpcError } = await supabase.rpc('bot_sync_discord_badges', {
      p_discord_id: id,
      p_public_flags: String(flags || 0),
      p_premium_type: Number(premiumType || 0),
      p_nitro_months: Math.max(0, Math.floor(Number(nitroMonths || 0))),
      p_boost_months: Math.max(0, Math.floor(Number(boostMonths || 0))),
    });
    if (rpcError && !rpcError.message?.includes('No rows')) console.error('[Profile flags]', rpcError.message);

    const patch = { discord_boost_months: Math.max(0, Number(boostMonths || 0)) };
    if (Number(nitroMonths) > 0) patch.discord_nitro_months = Math.floor(Number(nitroMonths));
    if (Number(premiumType) > 0) patch.premium_type = Number(premiumType);
    const { error } = await supabase.from('social_profiles').update(patch).eq('public_discord_id', id);
    if (error) console.error('[Profile metadata]', error.message);
  } catch (e) {
    console.error('[Profile sync]', e.message);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchDiscordJson(url, accessToken, { retries = 4 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (response.status === 429) {
        const body = await response.json().catch(() => ({}));
        const espera = Math.min(10000, Math.ceil(Number(body?.retry_after || 1) * 1000) + 250);
        if (body?.global) {
          console.warn(`[OAuth] 429 GLOBAL, espera ${espera}ms - varredura abortada`);
          return null;
        }
        if (attempt === retries) {
          console.warn(`[OAuth] ${url}: 429 apos ${retries + 1} tentativas (ultima espera ${espera}ms)`);
          return null;
        }
        await sleep(espera);
        continue;
      }
      if (!response.ok) {
        console.warn(`[OAuth] ${url}: HTTP ${response.status}`);
        return null;
      }
      const data = await response.json();
      return data && typeof data === 'object' ? data : null;
    } catch (e) {
      if (attempt === retries) {
        console.warn(`[OAuth] ${url}: ${e.message}`);
        return null;
      }
      await sleep(500);
    }
  }
  return null;
}

async function validateOAuthIdentity(accessToken, expectedUserId) {
  const me = await fetchDiscordJson('https://discord.com/api/v10/users/@me', accessToken);
  return me?.id && String(me.id) === String(expectedUserId) ? me : null;
}

function detectNitroFromAssets(user) {
  if (typeof user?.avatar === 'string' && user.avatar.startsWith('a_')) return 'avatar animado';
  if (typeof user?.banner === 'string' && user.banner.startsWith('a_')) return 'banner animado';
  return null;
}

function detectNitroFromMember(member) {
  if (typeof member?.avatar === 'string' && member.avatar) return 'avatar por servidor';
  if (typeof member?.banner === 'string' && member.banner) return 'banner por servidor';
  return null;
}

async function scanGuildsForPremium(accessToken) {
  const guilds = await fetchDiscordJson('https://discord.com/api/v10/users/@me/guilds', accessToken);
  if (!Array.isArray(guilds) || guilds.length === 0) return { boostMonths: null, nitroSource: null, scanned: 0, answered: 0, total: 0 };
  const ids = guilds.map(g => g?.id).filter(Boolean);
  const deadline = Date.now() + SCAN_DEADLINE_MS;
  let earliestBoost = null;
  let nitroSource = null;
  let cursor = 0;
  let answered = 0;

  const scan = async () => {
    while (cursor < ids.length && Date.now() < deadline) {
      const index = cursor++;
      if (index > 0) await sleep(SCAN_SPACING_MS);
      const member = await fetchDiscordJson(`https://discord.com/api/v10/users/@me/guilds/${ids[index]}/member`, accessToken);
      if (member) answered++;
      const since = member?.premium_since ? new Date(member.premium_since).getTime() : NaN;
      if (!Number.isNaN(since) && (earliestBoost === null || since < earliestBoost)) earliestBoost = since;
      if (!nitroSource) nitroSource = detectNitroFromMember(member);
    }
  };

  await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, ids.length) }, scan));
  return {
    boostMonths: earliestBoost === null ? null : Math.max(1, completedMonthsSince(new Date(earliestBoost))),
    nitroSource,
    scanned: cursor,
    answered,
    total: ids.length,
  };
}

async function syncMember(member, { preserveWhenPresenceMissing = true, oauth = null } = {}) {
  if (!member || member.user?.bot) return null;
  const user = member.user;
  if (!user.flags && typeof user.fetchFlags === 'function') await user.fetchFlags().catch(() => null);
  const fullUser = await user.fetch(true).catch(() => user);
  const flags = BigInt(fullUser.flags?.bitfield ?? user.flags?.bitfield ?? 0);
  const stored = await getStoredPremiumMeta(user.id);
  const nitroSource = detectNitroFromAssets({ avatar: fullUser.avatar, banner: fullUser.banner })
    || detectNitroFromMember({ avatar: member.avatar, banner: member.banner })
    || oauth?.nitroSource
    || null;
  const oauthPremiumType = Number(oauth?.premiumType || 0);
  const premiumType = Math.max(oauthPremiumType, nitroSource ? NITRO_GENERIC : 0, stored.premiumType);
  const guildBoost = member.premiumSince ? Math.max(1, completedMonthsSince(member.premiumSince)) : 0;
  const freshBoost = Math.max(guildBoost, Number(oauth?.boostMonths || 0));
  const boostMonths = freshBoost > 0 ? freshBoost : stored.boostMonths;
  const serialized = serializePresence(member.presence);

  if (serialized) {
    await upsertPresence(user.id, serialized.status, serialized.activities, serialized.spotify, flags, premiumType);
  } else if (!preserveWhenPresenceMissing) {
    await upsertPresence(user.id, 'offline', [], null, flags, premiumType);
  }
  await syncProfileDiscordMeta(user.id, flags, premiumType, boostMonths, stored.nitroMonths);
  return { premiumType, nitroMonths: stored.nitroMonths, boostMonths, flags: String(flags), nitroSource };
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
    const me = await validateOAuthIdentity(accessToken, userId);
    if (!me) return { ok: false, status: 401, error: 'Autorização do Discord não pertence a esta conta.' };
    oauth = await scanGuildsForPremium(accessToken);
    oauth.premiumType = Number(me.premium_type || 0);
    console.log(`[Scan] ${userId}: ${oauth.answered}/${oauth.total} guilds responderam (${oauth.scanned} tentadas), boost=${oauth.boostMonths ?? 'nenhum'}, nitro=${oauth.premiumType || oauth.nitroSource || 'nao detectado'}`);
  }

  const synced = await syncMember(member, { preserveWhenPresenceMissing: false, oauth });
  const scan = oauth ? {
    guildsVisiveis: oauth.total,
    guildsVarridas: oauth.scanned,
    guildsResponderam: oauth.answered,
    boostEncontrado: oauth.boostMonths,
    nitroEncontrado: oauth.premiumType || oauth.nitroSource,
    escopoGuildsOk: oauth.total > 0,
    bloqueadoPorRateLimit: oauth.total > 0 && oauth.answered === 0,
  } : null;
  return { ok: true, status: 200, synced, oauthUsed: Boolean(accessToken), scan };
}

function boosterStage(months) {
  const m = Math.max(0, Number(months || 0));
  if (m >= 24) return 9;
  if (m >= 18) return 8;
  if (m >= 15) return 7;
  if (m >= 12) return 6;
  if (m >= 9) return 5;
  if (m >= 6) return 4;
  if (m >= 3) return 3;
  if (m >= 2) return 2;
  if (m > 0) return 1;
  return 0;
}

function flagsToBadges(flagsValue) {
  let flags = 0n;
  try { flags = BigInt(String(flagsValue || '0')); } catch {}
  return DISCORD_BADGE_FLAGS
    .filter(b => (flags & (1n << BigInt(b.bit))) !== 0n)
    .map(b => ({ key: b.key, label: b.label, source: 'discord_public_flags' }));
}

async function getNormalizedDiscordBadges(userId) {
  const stored = await getStoredPremiumMeta(userId);
  const badges = flagsToBadges(stored.flags);
  if (stored.premiumType > 0) {
    badges.push({
      key: stored.premiumType === 3 ? 'nitro_basic' : 'nitro',
      label: stored.premiumType === 3 ? 'Discord Nitro Basic' : 'Discord Nitro',
      premiumType: stored.premiumType,
      months: stored.nitroMonths,
      source: stored.premiumType === NITRO_GENERIC ? 'verified_or_inferred' : 'discord_oauth',
    });
  }
  if (stored.boostMonths > 0) {
    badges.push({
      key: 'server_booster',
      label: 'Server Booster',
      months: stored.boostMonths,
      stage: boosterStage(stored.boostMonths),
      source: 'discord_guild_membership',
    });
  }
  return { userId: String(userId), badges, meta: stored };
}

function cleanupChallenges() {
  const now = Date.now();
  for (const [token, challenge] of nitroChallenges) {
    const expiry = challenge.status === 'verified' ? challenge.verifiedAt + NITRO_RESULT_TTL_MS : challenge.expiresAt;
    if (expiry <= now) {
      nitroChallenges.delete(token);
      if (nitroChallengeByUser.get(challenge.userId) === token) nitroChallengeByUser.delete(challenge.userId);
    }
  }
}

async function markNitroVerified(userId, flags, premiumType = NITRO_GENERIC) {
  const stored = await getStoredPremiumMeta(userId);
  const finalType = Math.max(Number(premiumType || 0), stored.premiumType, NITRO_GENERIC);
  await syncProfileDiscordMeta(userId, flags || stored.flags, finalType, stored.boostMonths, stored.nitroMonths);
  await supabase.from('user_presence').update({
    nitro_type: finalType,
    badges_bitfield: String(flags || stored.flags || 0),
    updated_at: new Date().toISOString(),
  }).eq('discord_id', userId);
  return finalType;
}

async function startNitroChallenge(userId, accessToken) {
  cleanupChallenges();
  if (!/^\d{17,20}$/.test(String(userId || ''))) return { ok: false, status: 400, error: 'Discord ID inválido.' };
  if (!accessToken) return { ok: false, status: 400, error: 'OAuth do Discord é necessário para iniciar a verificação.' };
  if (!client.isReady()) return { ok: false, status: 503, error: 'Bot ainda não está pronto.' };

  const me = await validateOAuthIdentity(accessToken, userId);
  if (!me) return { ok: false, status: 401, error: 'Autorização do Discord não pertence a esta conta.' };
  const flags = String(me.public_flags ?? me.flags ?? 0);

  // Se o app um dia receber identify.premium, não precisa de desafio nenhum.
  if (Number(me.premium_type || 0) > 0) {
    const premiumType = await markNitroVerified(String(userId), flags, Number(me.premium_type));
    return { ok: true, status: 200, verified: true, premiumType, method: 'identify.premium' };
  }

  const guild = client.guilds.cache.get(NICOTINA_GUILD_ID);
  if (!guild) return { ok: false, status: 503, error: 'Servidor do nicotina.lol indisponível.' };
  const member = await guild.members.fetch(String(userId)).catch(() => null);
  if (!member) return { ok: false, status: 404, error: 'Entre no servidor do nicotina.lol antes de verificar o Nitro.' };

  const stickers = await guild.stickers.fetch().catch(() => null);
  const usable = stickers ? [...stickers.values()].filter(s => s.available !== false) : [];
  if (!usable.length) {
    return { ok: false, status: 503, error: 'O servidor nicotina.lol precisa ter pelo menos uma figurinha personalizada para a prova de Nitro.' };
  }

  const previous = nitroChallengeByUser.get(String(userId));
  if (previous) nitroChallenges.delete(previous);
  const challengeToken = crypto.randomBytes(24).toString('hex');
  const challenge = {
    token: challengeToken,
    userId: String(userId),
    flags,
    status: 'pending',
    createdAt: Date.now(),
    expiresAt: Date.now() + NITRO_CHALLENGE_TTL_MS,
    verifiedAt: 0,
    stickerIds: new Set(usable.map(s => String(s.id))),
  };
  nitroChallenges.set(challengeToken, challenge);
  nitroChallengeByUser.set(String(userId), challengeToken);

  return {
    ok: true,
    status: 200,
    verified: false,
    challengeToken,
    expiresInSeconds: Math.floor(NITRO_CHALLENGE_TTL_MS / 1000),
    botUserId: client.user.id,
    guildId: guild.id,
    guildName: guild.name,
    acceptedStickers: usable.slice(0, 10).map(s => ({ id: s.id, name: s.name })),
    instruction: `Abra a DM de ${client.user.username} e envie uma figurinha personalizada do servidor ${guild.name}.`,
    method: 'discord_sticker_capability',
  };
}

function getNitroChallengeStatus(challengeToken) {
  cleanupChallenges();
  const challenge = nitroChallenges.get(String(challengeToken || ''));
  if (!challenge) return { ok: false, status: 404, error: 'Verificação não encontrada ou expirada.' };
  return {
    ok: true,
    status: 200,
    verification: {
      status: challenge.status,
      verified: challenge.status === 'verified',
      expiresAt: new Date(challenge.expiresAt).toISOString(),
      verifiedAt: challenge.verifiedAt ? new Date(challenge.verifiedAt).toISOString() : null,
    },
  };
}

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/') {
    sendJson(res, 200, { ok: true, service: 'nicotina-bot', discordReady: client.isReady(), badgeApi: 1 });
    return;
  }

  if (req.method === 'POST' && req.url === '/sync') {
    const { userId, accessToken } = await readBody(req);
    try {
      const result = await syncByDiscordId(userId, accessToken);
      sendJson(res, result.status, {
        success: result.ok,
        error: result.error,
        oauthUsed: result.oauthUsed,
        scan: result.scan,
        discordSync: result.synced || null,
      });
    } catch (e) {
      console.error('[Sync]', e);
      sendJson(res, 500, { error: 'Erro interno ao sincronizar Discord' });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/nitro/challenge') {
    const { userId, accessToken } = await readBody(req);
    try {
      const result = await startNitroChallenge(userId, accessToken);
      sendJson(res, result.status, { success: result.ok, ...result, status: undefined });
    } catch (e) {
      console.error('[Nitro challenge]', e);
      sendJson(res, 500, { success: false, error: 'Erro interno ao iniciar verificação de Nitro.' });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/nitro/challenge/status') {
    const { challengeToken } = await readBody(req);
    const result = getNitroChallengeStatus(challengeToken);
    sendJson(res, result.status, { success: result.ok, error: result.error, verification: result.verification || null });
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/discord-badges')) {
    try {
      const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const userId = parsed.searchParams.get('userId');
      if (!/^\d{17,20}$/.test(String(userId || ''))) {
        sendJson(res, 400, { success: false, error: 'Discord ID inválido.' });
        return;
      }
      const data = await getNormalizedDiscordBadges(userId);
      sendJson(res, 200, { success: true, ...data });
    } catch (e) {
      console.error('[Badge API]', e);
      sendJson(res, 500, { success: false, error: 'Erro interno ao carregar badges.' });
    }
    return;
  }

  res.writeHead(404);
  res.end();
}).listen(PORT, '0.0.0.0', () => console.log(`[WEB] porta ${PORT}`));

client.once('ready', async () => {
  console.log(`[BOT] ONLINE: ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) {
    try {
      const members = await guild.members.fetch({ withPresences: true });
      for (const member of members.values()) await syncMember(member);
    } catch (e) {
      console.error('[INIT]', guild.name, e.message);
    }
  }
});

client.on('messageCreate', async message => {
  if (message.author?.bot || message.guildId) return;
  cleanupChallenges();
  const token = nitroChallengeByUser.get(String(message.author.id));
  if (!token) return;
  const challenge = nitroChallenges.get(token);
  if (!challenge || challenge.status !== 'pending' || challenge.expiresAt <= Date.now()) return;

  const sentStickerIds = [...(message.stickers?.keys?.() || [])].map(String);
  const validSticker = sentStickerIds.some(id => challenge.stickerIds.has(id));
  if (!validSticker) return;

  try {
    const premiumType = await markNitroVerified(challenge.userId, challenge.flags, NITRO_GENERIC);
    challenge.status = 'verified';
    challenge.verifiedAt = Date.now();
    challenge.premiumType = premiumType;
    console.log(`[Nitro] ${challenge.userId} verificado por figurinha global.`);
    await message.reply('✅ Nitro verificado no nicotina.lol.').catch(() => null);
  } catch (e) {
    console.error('[Nitro verify]', e);
  }
});

client.on('presenceUpdate', async (_old, p) => {
  if (p?.member && !p.member.user?.bot) await syncMember(p.member, { preserveWhenPresenceMissing: false });
});
client.on('guildMemberAdd', async m => {
  if (!m.user?.bot) await syncMember(await m.guild.members.fetch({ user: m.id, force: true, withPresences: true }).catch(() => m));
});
client.on('guildMemberUpdate', async (_old, m) => {
  if (!m.user?.bot) await syncMember(m);
});
client.on('error', e => console.error('[ERRO BOT]', e));

if (!process.env.DISCORD_BOT_TOKEN) {
  console.error('DISCORD_BOT_TOKEN ausente');
  process.exit(1);
}
client.login(process.env.DISCORD_BOT_TOKEN.trim());
