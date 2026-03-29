require('dotenv').config();

const http = require('http');
const { Client, GatewayIntentBits } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

// 1. INICIALIZAÇÃO IMEDIATA DO SERVIDOR (PRO RENDER NÃO DAR TIMEOUT)
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Nicotina Bot Online!');
}).listen(PORT, '0.0.0.0', () => {
  console.log(`====> SERVIDOR WEB OK NA PORTA ${PORT} <====`);
});

// 2. CONFIGURAÇÃO SUPABASE
const supabase = createClient(
  process.env.SUPABASE_URL, 
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 3. CONFIGURAÇÃO DISCORD
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMembers
  ]
});

client.on('ready', () => {
  console.log(`====> BOT LOGADO COMO ${client.user.tag} <====`);
});

// LOG DE ERROS (Para a gente saber por que falhou)
client.on('error', (err) => console.error('ERRO DISCORD:', err));

// 4. LOGIN (Usando o nome da variável que você botou no Render)
client.login(process.env.DISCORD_BOT_TOKEN).catch(err => {
  console.error('FALHA NO LOGIN DO DISCORD:', err);
});

// EVENTO DE PRESENÇA (O que a gente quer)
client.on('presenceUpdate', async (oldP, newP) => {
  if (!newP || !newP.userId) return;
  console.log(`Atualizando status de: ${newP.user?.username}`);
  
  const discordId = newP.userId;
  const status = newP.status;
  
  // As flags do usuário (para computar de badges extras, se necessário)
  const badges_bitfield = newP.user?.flags?.bitfield || 0;
  
  // Pegando Spotify (se ativo)
  const spotifyActivity = newP.activities.find(a => a.name === 'Spotify');
  const spotify = spotifyActivity ? {
    title: spotifyActivity.details,
    artist: spotifyActivity.state,
    album: spotifyActivity.assets?.largeText,
    trackId: spotifyActivity.syncId
  } : null;

  // Demais atividades visuais
  const activities = newP.activities
    .filter(a => a.name !== 'Spotify')
    .map(a => ({
      name: a.name,
      state: a.state,
      details: a.details,
      type: a.type
    }));

  try {
    const { error } = await supabase.from('user_presence').upsert({
      discord_id: discordId,
      status: status,
      badges_bitfield: badges_bitfield,
      spotify: spotify,
      activities: JSON.stringify(activities),
      updated_at: new Date().toISOString()
    });
    
    if (error) {
      console.error(`Status update error for ${discordId}:`, error);
    } else {
      console.log(`[Presence] OK: ${newP.user?.username} -> ${status}`);
    }
  } catch (err) {
    console.error(`Erro fatal no Supabase para ${discordId}:`, err);
  }
});
