require('dotenv').config();
const http = require('http');
const { Client, GatewayIntentBits } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

// ─── 1. SERVIDOR WEB DO RENDER (COM ENDPOINT /JOIN) ───────────────────────────
const PORT = process.env.PORT || 10000;
const GUILD_ID = '1481726829810159671'; // IDs do Servidor Nicotina

http.createServer(async (req, res) => {
  // CORS simplificado para facilitar chamadas do frontend
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Endpoint de Saúde
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200);
    res.end('Nicotina Bot: Ativo!');
    return;
  }

  // Endpoint para Join Automático
  if (req.method === 'POST' && req.url === '/join') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { accessToken, userId } = JSON.parse(body);

        if (!accessToken || !userId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'accessToken e userId são necessários' }));
          return;
        }

        console.log(`[Join] Tentando adicionar usuário ${userId} ao servidor via OAuth2...`);

        const response = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bot ${process.env.DISCORD_BOT_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ access_token: accessToken })
        });

        if (response.status === 201) {
          console.log(`[Join] ✅ Usuário ${userId} adicionado com sucesso!`);
          res.writeHead(201);
          res.end(JSON.stringify({ success: true, message: 'Adicionado' }));
        } else if (response.status === 204) {
          console.log(`[Join] ℹ️ Usuário ${userId} já está no servidor.`);
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, message: 'Já é membro' }));
        } else {
          const errorData = await response.json();
          console.error(`[Join] ❌ Erro da API Discord (${response.status}):`, errorData);
          res.writeHead(response.status);
          res.end(JSON.stringify({ success: false, error: errorData }));
        }
      } catch (err) {
        console.error('[Join] 💥 Erro no processamento:', err);
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Erro interno no servidor do bot' }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
}).listen(PORT, '0.0.0.0', () => {
  console.log(`[1] SERVIDOR WEB OK - PORTA ${PORT}`);
});

// ─── 2. SUPABASE ──────────────────────────────────────────────────────────────
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('⚠️ ERRO CRÍTICO: Variáveis SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausentes!');
  process.exit(1);
}
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── 3. BOT DISCORD ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMembers,
  ],
});

client.on('ready', async () => {
  console.log(`[3] ✅ BOT ONLINE: ${client.user.tag}`);

  // Sincronização inicial: percorre todos os membros de todos os servidores
  for (const guild of client.guilds.cache.values()) {
    try {
      const members = await guild.members.fetch();
      console.log(`[INIT] Sincronizando ${members.size} membros de "${guild.name}"...`);

      for (const member of members.values()) {
        const user = member.user;
        if (user.bot) continue;

        const discordId = user.id;
        const badgesBitfield = BigInt(user.flags ? user.flags.bitfield : 0);
        const hasAnimatedAvatar = user.avatar ? user.avatar.startsWith('a_') : false;
        const nitroType = hasAnimatedAvatar ? 2 : 0;

        await upsertPresence(discordId, 'offline', [], null, badgesBitfield, nitroType);
        await syncBadgesInProfile(discordId, badgesBitfield, nitroType);
      }
    } catch (err) {
      console.error(`[INIT] Erro ao sincronizar membros de ${guild.name}:`, err.message);
    }
  }

  console.log('[INIT] ✅ Sincronização inicial concluída.');
});

client.on('error', (e) => console.error('[ERRO BOT]', e));

// ─── 4. PRESENÇA EM TEMPO REAL ────────────────────────────────────────────────
client.on('presenceUpdate', async (oldPresence, newPresence) => {
  if (!newPresence || !newPresence.user) return;

  const user = newPresence.user;
  const discordId = user.id;
  if (user.bot) return;

  const status = newPresence.status || 'offline';
  let badgesBitfield = BigInt(user.flags ? user.flags.bitfield : 0);
  let nitroType = 0;

  try {
    const guild = newPresence.guild;
    if (guild) {
      const member = await guild.members.fetch({ user: discordId, force: true }).catch(() => null);
      if (member) {
        badgesBitfield = BigInt(member.user.flags ? member.user.flags.bitfield : 0);
        const hasAnimatedAvatar = member.user.avatar ? member.user.avatar.startsWith('a_') : false;
        nitroType = hasAnimatedAvatar ? 2 : 0;
      }
    }
  } catch (err) {
    console.warn(`[FLAGS] Não foi possível buscar member completo de ${discordId}:`, err.message);
  }

  let spotify = null;
  const activities = [];
  for (const activity of newPresence.activities) {
    if (activity.name === 'Spotify') {
      spotify = {
        title: activity.details || '',
        artist: activity.state || '',
        album: activity.assets?.largeImage || null,
        trackId: activity.syncId || null,
      };
    } else {
      activities.push({
        id: activity.id || activity.name,
        name: activity.name,
        details: activity.details || '',
        state: activity.state || '',
        type: activity.type,
      });
    }
  }

  await upsertPresence(discordId, status, activities, spotify, badgesBitfield, nitroType);
  await syncBadgesInProfile(discordId, badgesBitfield, nitroType);
});

async function upsertPresence(discordId, status, activities, spotify, badgesBitfield, nitroType) {
  try {
    const { error } = await supabase
      .from('user_presence')
      .upsert({
        discord_id: discordId,
        status: status,
        badges_bitfield: String(badgesBitfield), // Salva como string para suportar BigInt no Supabase
        nitro_type: nitroType,
        spotify: spotify,
        activities: activities,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'discord_id' });

    if (error) {
      console.error(`[Presence] Erro ao sincronizar ${discordId}:`, error.message);
    } else {
      console.log(`[Presence] ✅ ${discordId} → ${status} | flags=${badgesBitfield}`);
    }
  } catch (err) {
    console.error(`[Presence CATCH] ${discordId}:`, err.message);
  }
}

async function syncBadgesInProfile(discordId, publicFlags, premiumType) {
  if (!discordId || publicFlags === undefined) return;

  try {
    const { error } = await supabase.rpc('bot_sync_discord_badges', {
      p_discord_id: discordId,
      p_public_flags: String(publicFlags), // BigInt via String para o RPC
      p_premium_type: premiumType || 0,
    });

    if (error) {
      if (!error.message?.includes('No rows')) {
        console.error(`[Profile Sync] Erro ao sincronizar badge de ${discordId}:`, error.message);
      }
    } else {
      console.log(`[Profile Sync] ✅ Badges de ${discordId} sincronizadas.`);
    }
  } catch (err) {
    console.error(`[Profile Sync CATCH] ${discordId}:`, err.message);
  }
}

if (!process.env.DISCORD_BOT_TOKEN) {
  console.error('❌ ERRO: DISCORD_BOT_TOKEN ausente!');
  process.exit(1);
}
client.login(process.env.DISCORD_BOT_TOKEN.trim());
