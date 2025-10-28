require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder } = require('discord.js');
const express = require('express');
// ← REMOVE: const fetch = require('node-fetch');
const crypto = require('crypto');

// Node.js 18+ has global fetch() — just use it
const client = new Client({ 
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] 
});

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let users = {};

const ESI_BASE = 'https://esi.evetech.net/latest';
const AUTH_URL = 'https://login.eveonline.com/v2/oauth/authorize';
const TOKEN_URL = 'https://login.eveonline.com/v2/oauth/token';
const SCOPES = 'esi-contracts.read_character_contracts.v1';

function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

client.once('ready', async () => {
  console.log(`Bot online: ${client.user.tag}`);
  await client.application.commands.set([
    new SlashCommandBuilder().setName('setup').setDescription('Link EVE character'),
    new SlashCommandBuilder().setName('status').setDescription('View monitored characters'),
    new SlashCommandBuilder().setName('remove').setDescription('Remove character').addStringOption(o => 
      o.setName('name').setDescription('Character name').setRequired(true)
    )
  ]);
  console.log('Commands registered.');
});

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;
  try {
    const { commandName, user, channelId } = i;

    if (commandName === 'setup') {
      const state = crypto.randomBytes(16).toString('hex');
      const { verifier, challenge } = generatePKCE();
      users[state] = { verifier, userId: user.id, channelId };

      const url = `${AUTH_URL}?response_type=code&redirect_uri=${encodeURIComponent(process.env.CALLBACK_URL)}&client_id=${process.env.EVE_CLIENT_ID}&scope=${SCOPES}&code_challenge=${challenge}&code_challenge_method=S256&state=${state}`;
      await i.reply({ content: `Click to link: ${url}`, flags: 64 });
    }

    if (commandName === 'status') {
      const chars = users[user.id] || [];
      if (!chars.length) return i.reply({ content: 'No characters. Use /setup', flags: 64 });
      const list = chars.map(c => `• **${c.charName}** (ID: ${c.charId})`).join('\n');
      await i.reply({ content: `Monitoring ${chars.length} character(s):\n${list}`, flags: 64 });
    }

    if (commandName === 'remove') {
      const name = i.options.getString('name');
      const chars = users[user.id];
      if (!chars) return i.reply({ content: 'Nothing to remove.', flags: 64 });
      const idx = chars.findIndex(c => c.charName.toLowerCase() === name.toLowerCase());
      if (idx === -1) return i.reply({ content: `Not found: ${name}`, flags: 64 });
      chars.splice(idx, 1);
      await i.reply({ content: `Removed **${name}**.`, flags: 64 });
    }
  } catch (err) {
    console.error('Interaction error:', err);
    if (!i.replied) await i.reply({ content: 'Error.', flags: 64 }).catch(() => {});
  }
});

app.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  console.log('Callback received:', { code: code ? 'present' : 'missing', state });

  if (!code || !state || !users[state]) {
    return res.status(400).send('<h1>Invalid Link</h1><p>Run /setup again.</p>');
  }

  const { verifier, userId, channelId } = users[state];
  delete users[state];

  try {
    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: process.env.EVE_CLIENT_ID,
        code_verifier: verifier
      })
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error('No access token');

    const payload = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString());
    const charId = parseInt(payload.sub.split(':')[2]);

    const charRes = await fetch(`${ESI_BASE}/characters/${charId}/`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const charData = await charRes.json();
    const charName = charData.name;

    if (!users[userId]) users[userId] = [];
    const existing = users[userId].find(c => c.charId === charId);
    if (existing) {
      Object.assign(existing, {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + tokens.expires_in * 1000,
        lastPoll: new Date().toISOString()
      });
    } else {
      users[userId].push({
        charId, charName,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + tokens.expires_in * 1000,
        channelId,
        lastPoll: new Date().toISOString()
      });
    }

    const channel = await client.channels.fetch(channelId);
    await channel.send(`**${charName}** linked! Use /status.`);

    res.send(`<h1>Success!</h1><p>${charName} is now linked. Close this tab.</p>`);
  } catch (err) {
    console.error('Auth error:', err);
    res.status(500).send('<h1>Failed</h1><p>Try /setup again.</p>');
  }
});

setInterval(async () => {
  for (const [userId, chars] of Object.entries(users)) {
    if (!Array.isArray(chars)) continue;
    for (const char of chars) {
      if (Date.now() > char.expires_at) {
        try {
          const res = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Authorization': 'Basic ' + Buffer.from(`${process.env.EVE_CLIENT_ID}:${process.env.EVE_CLIENT_SECRET}`).toString('base64')
            },
            body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: char.refresh_token })
          });
          const t = await res.json();
          char.access_token = t.access_token;
          char.expires_at = Date.now() + t.expires_in * 1000;
        } catch (e) { console.error('Refresh failed:', e); continue; }
      }
      try {
        const res = await fetch(`${ESI_BASE}/characters/${char.charId}/contracts/`, {
          headers: { Authorization: `Bearer ${char.access_token}` }
        });

        
const contracts = await res.json();
console.log(`DEBUG Poll: ${char.charName} has ${contracts.length} contracts`);

const lastPoll = new Date(char.lastPoll);
const newEvents = contracts.filter(c => 
  c.date_accepted && new Date(c.date_accepted) > lastPoll
);

console.log(`New events since ${lastPoll.toISOString()}: ${newEvents.length}`);

// SEND ALERTS
if (newEvents.length > 0) {
  console.log(`ALERT: ${newEvents.length} new event(s) for ${char.charName}`);
  const channel = await client.channels.fetch(char.channelId);

  for (const c of newEvents) {
    let title = '', color = 0x000000, statusText = '';

    if (c.status === 'finished') {
      title = 'Contract Completed!';
      color = 0x00ff00;
      statusText = 'Finished';
    } else if (c.status === 'rejected') {
      title = 'Contract Rejected!';
      color = 0xff0000;
      statusText = 'Rejected';
    } else if (c.status === 'in_progress' || c.status === 'accepted') {
      title = 'Contract Accepted!';
      color = 0x0099ff;
      statusText = 'Accepted';
    } else continue;

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(`**${char.charName}**`)
      .addFields(
        { name: 'Status', value: statusText, inline: true },
        { name: 'ID', value: `${c.contract_id}`, inline: true },
        { name: 'Title', value: c.title || '—', inline: false },
        { name: 'Time', value: `<t:${Math.floor(new Date(c.date_accepted).getTime()/1000)}:F>`, inline: false }
      )
      .setColor(color);

    await channel.send({ content: `<@${userId}>`, embeds: [embed] });
  }
}

// UPDATE lastPoll — **ALWAYS**
char.lastPoll = new Date().toISOString();


        
      } catch (e) { console.error('Poll error:', e); }
    }
  }
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
client.login(process.env.DISCORD_TOKEN);
