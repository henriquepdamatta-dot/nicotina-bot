require('dotenv').config(); // Caso você teste local
const http = require('http');
const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

// 1. SERVIDOR WEB DO RENDER (COM ENDPOINT /JOIN)
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
    res.end('Nicotina Bot Ativo e Fechando Presence!');
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

// 2. CONEXÃO SUPABASE
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("⚠️ ERRO CRÍTICO: Variáveis SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configuradas no Render!");
}
const supabase = createClient(
  process.env.SUPABASE_URL, 
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 3. O BOT DISCORD
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMembers
  ]
});

client.on('ready', () => {
  console.log(`[3] ✅ BOT ONLINE: ${client.user.tag} - Iniciando sincronização Real-Time!`);
});

client.on('error', e => console.error("[ERRO BOT]", e));

// 4. A MÁGICA REAL TIME (SINCRONIZAÇÃO PRESENCE)
client.on('presenceUpdate', async (oldPresence, newPresence) => {
  if (!newPresence) return;

  const discordId = newPresence.user.id;
  const status = newPresence.status || 'offline';
  
  // Bitfield de Insígnias e Tipo de Nitro (vem do objeto de membro/usuário)
  const badgesBitfield = newPresence.user.flags ? newPresence.user.flags.bitfield : 0;
  // O Discord.js no Presence Update não entrega diretamente o nitro_type, 
  // mas podemos garantir que o bitfield tá atualizado.

  // Parse das Atividades e Spotify
  let spotify = null;
  const activities = [];

  for (const activity of newPresence.activities) {
    if (activity.name === 'Spotify') {
      spotify = {
        title: activity.details,   // Nome da Música
        artist: activity.state,    // Artista
        album: activity.assets?.largeImage || null, // ID da Capa
        trackId: activity.syncId || null
      };
    } else {
      activities.push({
        id: activity.id || activity.name,
        name: activity.name,
        details: activity.details || '',
        state: activity.state || '',
        type: activity.type
      });
    }
  }

  try {
    const { error } = await supabase
      .from('user_presence')
      .upsert({
        discord_id: discordId,
        status: status,
        badges_bitfield: badgesBitfield,
        spotify: spotify,
        activities: activities,
        updated_at: new Date().toISOString()
      }, { onConflict: 'discord_id' });

    if (error) {
      console.error(`[Supabase] Erro ao sincronizar ${discordId}:`, error.message);
    } else {
      console.log(`[Supabase] ❤️ Presença de ${discordId} atualizada! (${status})`);
    }
  } catch (err) {
    console.error(`[CATCH] Erro fatal no Upsert de ${discordId}:`, err);
  }
});

// INITIALIZATION
if (!process.env.DISCORD_BOT_TOKEN) {
  console.error("❌ ERRO: DISCORD_BOT_TOKEN vazia!");
} else {
  client.login(process.env.DISCORD_BOT_TOKEN.trim());
}
