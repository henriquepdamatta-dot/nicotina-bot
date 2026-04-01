require('dotenv').config();
const http = require('http');
const { Client, GatewayIntentBits } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

// ─── 1. SERVIDOR WEB DO RENDER ────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Nicotina Bot: Ativo!');
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
  // para garantir que as insígnias já armazenadas estejam corretas.
  for (const guild of client.guilds.cache.values()) {
    try {
      const members = await guild.members.fetch();
      console.log(`[INIT] Sincronizando ${members.size} membros de "${guild.name}"...`);

      for (const member of members.values()) {
        const user = member.user;
        if (user.bot) continue;

        const discordId      = user.id;
        const badgesBitfield = user.flags ? user.flags.bitfield : 0;
        // Usamos o campo público do user para detectar avatar animado (proxy de Nitro ativo).
        const hasAnimatedAvatar = user.avatar ? user.avatar.startsWith('a_') : false;
        const nitroType = hasAnimatedAvatar ? 2 : 0; // estimativa conservadora

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

  const user      = newPresence.user;
  const discordId = user.id;
  if (user.bot) return;

  const status         = newPresence.status || 'offline';
  const badgesBitfield = user.flags ? user.flags.bitfield : 0;

  // Tentar buscar o member completo para obter as flags mais atualizadas
  // (presenceUpdate pode chegar com user parcial)
  let finalFlags = badgesBitfield;
  let nitroType  = 0;

  try {
    const guild = newPresence.guild;
    if (guild) {
      const member = await guild.members.fetch({ user: discordId, force: true }).catch(() => null);
      if (member) {
        finalFlags = member.user.flags ? member.user.flags.bitfield : badgesBitfield;
        const hasAnimatedAvatar = member.user.avatar ? member.user.avatar.startsWith('a_') : false;
        nitroType = hasAnimatedAvatar ? 2 : 0;
      }
    }
  } catch (err) {
    console.warn(`[FLAGS] Não foi possível buscar member completo de ${discordId}:`, err.message);
  }

  // Parse Spotify e atividades
  let spotify = null;
  const activities = [];

  for (const activity of newPresence.activities) {
    if (activity.name === 'Spotify') {
      spotify = {
        title:   activity.details || '',
        artist:  activity.state   || '',
        album:   activity.assets?.largeImage || null,
        trackId: activity.syncId  || null,
      };
    } else {
      activities.push({
        id:      activity.id || activity.name,
        name:    activity.name,
        details: activity.details || '',
        state:   activity.state   || '',
        type:    activity.type,
      });
    }
  }

  await upsertPresence(discordId, status, activities, spotify, finalFlags, nitroType);
  await syncBadgesInProfile(discordId, finalFlags, nitroType);
});

// ─── 5. HELPERS ───────────────────────────────────────────────────────────────

/**
 * Faz upsert na tabela user_presence (presença em tempo real).
 */
async function upsertPresence(discordId, status, activities, spotify, badgesBitfield, nitroType) {
  try {
    const { error } = await supabase
      .from('user_presence')
      .upsert({
        discord_id:      discordId,
        status:          status,
        badges_bitfield: badgesBitfield,
        nitro_type:      nitroType,
        spotify:         spotify,
        activities:      activities,
        updated_at:      new Date().toISOString(),
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

/**
 * Sincroniza public_flags e premium_type em social_profiles via RPC.
 * Isso garante que as insígnias apareçam mesmo quando o usuário está offline.
 */
async function syncBadgesInProfile(discordId, publicFlags, premiumType) {
  if (!discordId || publicFlags === undefined) return;

  try {
    const { error } = await supabase.rpc('bot_sync_discord_badges', {
      p_discord_id:   discordId,
      p_public_flags: publicFlags,
      p_premium_type: premiumType || 0,
    });

    if (error) {
      // Silencia erro de UPDATE sem linhas (usuário sem perfil no site)
      if (!error.message?.includes('No rows')) {
        console.error(`[Profile Sync] Erro ao sincronizar badge de ${discordId}:`, error.message);
      }
    } else {
      console.log(`[Profile Sync] ✅ Badges de ${discordId} sincronizadas no perfil.`);
    }
  } catch (err) {
    console.error(`[Profile Sync CATCH] ${discordId}:`, err.message);
  }
}

// ─── 6. LOGIN ────────────────────────────────────────────────────────────────
if (!process.env.DISCORD_BOT_TOKEN) {
  console.error('❌ ERRO: DISCORD_BOT_TOKEN ausente!');
  process.exit(1);
}

client.login(process.env.DISCORD_BOT_TOKEN.trim());
