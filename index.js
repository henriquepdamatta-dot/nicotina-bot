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

console.log("[2] Iniciando processo de login...");

const token = process.env.DISCORD_BOT_TOKEN;

if (!token) {
  console.error("❌ ERRO: A variável DISCORD_BOT_TOKEN está vazia no Render!");
} else {
  // O .trim() remove espaços invisíveis que você pode ter copiado sem querer
  const tokenLimpo = token.trim();
  
  console.log(`[DEBUG] Token carregado (Inicia com: ${tokenLimpo.substring(0, 10)}...)`);
  console.log(`[DEBUG] Tamanho do token: ${tokenLimpo.length} caracteres`);

  client.login(tokenLimpo)
    .then(() => {
      console.log(`[3] ✅ SUCESSO: O bot ${client.user.tag} está ONLINE!`);
    })
    .catch(err => {
      console.error('[ERRO NO LOGIN]:', err.message);
      if (err.message.includes("Privileged intent")) {
        console.error("⚠️ O Discord negou as Intents. Verifique se você SALVOU no Developer Portal.");
      }
    });
}

// Timeout de segurança: se em 20 segundos não logar, ele avisa
setTimeout(() => {
  if (!client.user) {
    console.log("⏳ AVISO: O login está demorando demais. Pode ser rede ou Token bloqueado.");
  }
}, 20000);
