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
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('💥 ERRO CRÍTICO: SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausentes!');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMembers,
  ],
});

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
        title: activity.details || '',
        artist: activity.state || '',
        album: normalizeSpotifyAsset(activity.assets?.largeImage || null),
        albumName: activity.assets?.largeText || '',
        trackId: activity.syncId || null,
        timestamps: activity.timestamps
          ? {
              start: activity.timestamps.start?.getTime?.() ?? 0,
              end: activity.timestamps.end?.getTime?.() ?? 0,
            }
          : { start: 0, end: 0 },
      };
      continue;
    }

    activities.push({
      id: activity.id || activity.name,
      name: activity.name,
      details: activity.details || '',
      state: activity.state || '',
      type: activity.type,
      application_id: activity.applicationId || null,
      assets: activity.assets
        ? {
            large_image: activity.assets.largeImage || null,
            large_text: activity.assets.largeText || null,
            small_image: activity.assets.smallImage || null,
            small_text: activity.assets.smallText || null,
          }
        : null,
      timestamps: activity.timestamps
        ? {
            start: activity.timestamps.start?.getTime?.() ?? null,
            end: activity.timestamps.end?.getTime?.() ?? null,
          }
        : null,
    });
  }

  return {
    status: presence.status || 'offline',
    spotify,
    activities,
  };
}

async function upsertPresence(discordId, status, activities, spotify, badgesBitfield, nitroType) {
  try {
    const { error } = await supabase.from('user_presence').upsert(
      {
        discord_id: discordId,
        status,
        badges_bitfield: String(badgesBitfield),
        nitro_type: nitroType,
        spotify,
        activities,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'discord_id' }
    );

    if (error) console.error(`[Presence] Erro ao sincronizar ${discordId}:`, error.message);
    else console.log(`[Presence] ✅ ${discordId} → ${status} | acts=${activities.length} | spotify=${Boolean(spotify)}`);
  } catch (err) {
    console.error(`[Presence CATCH] ${discordId}:`, err.message);
  }
}

async function syncBadgesInProfile(discordId, publicFlags, premiumType) {
  if (!discordId || publicFlags === undefined) return;
  try {
    const { error } = await supabase.rpc('bot_sync_discord_badges', {
      p_discord_id: discordId,
      p_public_flags: String(publicFlags),
      p_premium_type: premiumType || 0,
    });
    if (error) {
      if (!error.message?.includes('No rows')) console.error(`[Profile Sync] Erro ao sincronizar badge de ${discordId}:`, error.message);
    } else {
      console.log(`[Profile Sync] ✅ Badges de ${discordId} sincronizadas.`);
    }
  } catch (err) {
    console.error(`[Profile Sync CATCH] ${discordId}:`, err.message);
  }
}

async function syncMember(member, { preserveWhenPresenceMissing = true } = {}) {
  if (!member || member.user?.bot) return;

  const user = member.user;
  const discordId = user.id;
  const badgesBitfield = BigInt(user.flags ? user.flags.bitfield : 0);
  const hasAnimatedAvatar = user.avatar ? user.avatar.startsWith('a_') : false;
  const nitroType = hasAnimatedAvatar ? 2 : 0;
  const serialized = serializePresence(member.presence);

  // Presence ausente no boot não significa necessariamente offline. Não apagamos uma
  // presença válida já armazenada só porque o Gateway ainda não a entregou.
  if (serialized) {
    await upsertPresence(discordId, serialized.status, serialized.activities, serialized.spotify, badgesBitfield, nitroType);
  } else if (!preserveWhenPresenceMissing) {
    await upsertPresence(discordId, 'offline', [], null, badgesBitfield, nitroType);
  }

  await syncBadgesInProfile(discordId, badgesBitfield, nitroType);
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
      const response = await fetch(`https://discord.com/api/v10/guilds/${NICOTINA_GUILD_ID}/members/${userId}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ access_token: accessToken }),
      });

      if (response.status === 201 || response.status === 204) {
        const guild = client.guilds.cache.get(NICOTINA_GUILD_ID);
        if (guild) {
          // Pede a presença deste usuário imediatamente após o join/login.
          const fetched = await guild.members.fetch({ user: userId, force: true, withPresences: true }).catch(() => null);
          if (fetched) await syncMember(fetched);
        }
        res.writeHead(response.status === 201 ? 201 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: response.status === 201 ? 'Adicionado ao servidor' : 'Já é membro' }));
      } else {
        const errorData = await response.json().catch(() => ({}));
        console.error(`[Join] ❌ Erro Discord (${response.status}):`, errorData);
        res.writeHead(response.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: errorData }));
      }
    } catch (err) {
      console.error('[Join] 💥 Erro:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Erro interno no servidor do bot' }));
    }
    return;
  }

  res.writeHead(404);
  res.end();
}).listen(PORT, '0.0.0.0', () => console.log(`[WEB] Servidor HTTP ativo na porta ${PORT}`));

client.once('ready', async () => {
  console.log(`[BOT] ✅ ONLINE: ${client.user.tag}`);

  for (const guild of client.guilds.cache.values()) {
    try {
      // Discord.js pode solicitar os membros com presença. Isso evita o bug antigo
      // que marcava todos offline e apagava Spotify/atividades em todo restart.
      const members = await guild.members.fetch({ withPresences: true });
      console.log(`[INIT] Sincronizando ${members.size} membros de "${guild.name}" com presença...`);
      for (const member of members.values()) await syncMember(member);
    } catch (err) {
      console.error(`[INIT] Erro ao sincronizar membros de ${guild.name}:`, err.message);
    }
  }

  console.log('[INIT] ✅ Sincronização inicial concluída.');
});

client.on('presenceUpdate', async (_oldPresence, newPresence) => {
  if (!newPresence?.userId) return;
  const member = newPresence.member;
  if (!member || member.user?.bot) return;
  await syncMember(member, { preserveWhenPresenceMissing: false });
});

client.on('guildMemberAdd', async (member) => {
  if (member.user?.bot) return;
  const fetched = await member.guild.members.fetch({ user: member.id, force: true, withPresences: true }).catch(() => member);
  await syncMember(fetched);
});

client.on('guildMemberUpdate', async (_oldMember, newMember) => {
  if (newMember.user?.bot) return;
  await syncMember(newMember);
});

client.on('error', (e) => console.error('[ERRO BOT]', e));

if (!process.env.DISCORD_BOT_TOKEN) {
  console.error('💥 ERRO: DISCORD_BOT_TOKEN ausente!');
  process.exit(1);
}
client.login(process.env.DISCORD_BOT_TOKEN.trim());
