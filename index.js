const http = require('http');
const { Client, GatewayIntentBits } = require('discord.js');

// 1. SERVIDOR WEB IMEDIATO
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Nicotina Online');
}).listen(PORT, '0.0.0.0', () => {
  console.log(`[1] SERVIDOR WEB OK - PORTA ${PORT}`);
});

// 2. TESTE DE CONEXÃO BRUTA (SEM BIBLIOTECA)
async function testConnection() {
  console.log("[2] Testando internet do servidor...");
  try {
    const res = await fetch('https://discord.com/api/v10/gateway');
    const data = await res.json();
    console.log("[3] Conexão com Discord API: OK!", data.url);
  } catch (err) {
    console.error("[ERRO] Servidor não consegue alcançar o Discord:", err.message);
  }
}

testConnection();

// 3. O BOT (COM LOGS DE CADA PASSO)
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMembers
  ]
});

console.log("[4] Preparando login...");

client.on('debug', d => {
  if (d.includes('heartbeat') || d.includes('latency')) return; // ignora lixo
  console.log(`[DEBUG] ${d}`);
});

client.on('ready', () => {
  console.log(`[5] ✅ BOT ONLINE: ${client.user.tag}`);
});

client.on('error', e => console.error("[ERRO BOT]", e));

// LOGIN COM TIMEOUT PARA NÃO FICAR PRESO
const loginTimer = setTimeout(() => {
  console.log("⚠️ O login está demorando mais de 15 segundos. Algo está errado na rede.");
}, 15000);

client.login(process.env.DISCORD_BOT_TOKEN.trim()).then(() => {
  clearTimeout(loginTimer);
});
