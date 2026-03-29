import { Client, GatewayIntentBits } from 'discord.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import http from 'http';

dotenv.config();

// Isso cria uma página básica para o cron-job.org visitar
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.write('Nicotina Bot Status: Online e Operante!');
  res.end();
}).listen(process.env.PORT || 3000);

console.log("Servidor Web de monitoramento iniciado!");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !DISCORD_BOT_TOKEN) {
  console.error("Faltam variáveis de ambiente (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DISCORD_BOT_TOKEN).");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // necessita privilégio
    GatewayIntentBits.GuildPresences // necessita privilégio
  ]
});

client.once('ready', () => {
  console.log(`📡 Bot conectado como ${client.user.tag}! Monitorando presença...`);
});

client.on('presenceUpdate', async (oldPresence, newPresence) => {
  if (!newPresence || !newPresence.user || newPresence.user.bot) return;

  const discordId = newPresence.userId;
  const status = newPresence.status;
  
  // As flags do usuário (para computar de badges extras, se necessário)
  const badges_bitfield = newPresence.user.flags?.bitfield || 0;
  
  // Pegando Spotify (se ativo)
  const spotifyActivity = newPresence.activities.find(a => a.name === 'Spotify');
  const spotify = spotifyActivity ? {
    title: spotifyActivity.details,
    artist: spotifyActivity.state,
    album: spotifyActivity.assets?.largeText,
    trackId: spotifyActivity.syncId
  } : null;

  // Demais atividades visuais
  const activities = newPresence.activities
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
      console.log(`[Presence] OK: ${newPresence.user.username} -> ${status}`);
    }
  } catch (err) {
    console.error(`Erro fatal no Supabase para ${discordId}:`, err);
  }
});

client.login(DISCORD_BOT_TOKEN);
