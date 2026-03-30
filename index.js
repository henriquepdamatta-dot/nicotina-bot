const http = require('http');
const { Client, GatewayIntentBits } = require('discord.js');

// 1. SERVIDOR WEB (PRO RENDER FICAR FELIZ)
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Nicotina Bot Online');
}).listen(PORT, '0.0.0.0', () => {
  console.log(`[1] SERVIDOR WEB OK NA PORTA ${PORT}`);
});

// 2. CONFIGURAÇÃO DO BOT (INTENTS EXPLÍCITAS)
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMembers
  ]
});

// 3. EVENTO DE LOGIN
client.once('ready', () => {
  console.log(`[3] SUCESSO: Bot ${client.user.tag} está ONLINE no Discord!`);
});

// 4. TRATAMENTO DE ERROS (O GRITO)
process.on('unhandledRejection', error => {
  console.error('[ERRO NÃO TRATADO]:', error);
});

console.log("[2] Tentando login no Discord...");

// USE O NOME EXATO QUE ESTÁ NO RENDER (DISCORD_BOT_TOKEN)
client.login(process.env.DISCORD_BOT_TOKEN).catch(err => {
  console.error('[ERRO NO LOGIN]:', err.message);
});
