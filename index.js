require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder } = require('discord.js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// CONFIG & CONSTANTS
const DATA_FILE = path.join(__dirname, 'data', 'users.json');
const ESI_BASE = 'https://esi.evetech.net/latest';
const AUTH_URL = 'https://login.eveonline.com/v2/oauth/authorize';
const TOKEN_URL = 'https://login.eveonline.com/v2/oauth/token';
const SCOPES = 'esi-contracts.read_character_contracts.v1';
const PORT = process.env.PORT || 3000;

const client = new Client({ 
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] 
});
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// === PERSISTED USERS ===
let users = {};
try {
  if (fs.existsSync(DATA_FILE)) {
    users = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    console.log(`Loaded ${Object.keys(users).length} users from disk`);
  } else {
    console.log('No saved users found, starting fresh');
  }
} catch (err) { console.error('Failed to load users:', err); }

function saveUsers() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2));
    console.log('Users saved to disk');
  } catch (err) {
    console.error('Failed to save users:', err);
  }
}

// === UTILS ===
function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
async function refreshToken(char) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${process.env.EVE_CLIENT_ID}:${process.env.EVE_CLIENT_SECRET}`).toString('base64')
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: char.refresh_token })
  });
  if (!res.ok) throw new Error(`Refresh failed: HTTP ${res.status}`);
  const t = await res.json();
  char.access_token = t.access_token;
  char.expires_at = Date.now() + t.expires_in * 1000;
}

// === DISCORD COMMANDS ===
client.once('ready', async () => {
  console.log(`Bot online: ${client.user.tag}`);
  await client.application.commands.set([
    new SlashCommandBuilder().setName('setup').setDescription('Link EVE character'),
    new SlashCommandBuilder().setName('status').setDescription('View monitored characters'),
    new SlashCommandBuilder().setName('remove').setDescription('Remove character').addStringOption(o =>
      o.setName('name').setDescription('Character name').setRequired(true)
    ),
    new SlashCommandBuilder().setName('resetpoll').setDescription('Reset poll timer (testing)')
  ]);
  console.log('Commands registered.');
});

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;
  const { commandName, user, channelId } = i;
  try {
    switch(commandName) {
      case 'setup': {
        const state = crypto.randomBytes(16).toString('hex');
        const { verifier, challenge } = generatePKCE();
        users[state] = { verifier, userId: user.id, channelId };
        const url = `${AUTH_URL}?response_type=code&redirect_uri=${encodeURIComponent(process.env.CALLBACK_URL)}&client_id=${process.env.EVE_CLIENT_ID}&scope=${SCOPES}&code_challenge=${challenge}&code_challenge_method=S256&state=${state}`;
        await i.reply({ content: `Click to link: ${url}`, flags: 64 });
        break;
      }
      case 'status': {
        const chars = users[user.id] || [];
        if (!chars.length) return i.reply({ content: 'No characters. Use /setup', flags: 64 });
        const list = chars.map(c => `• **${c.charName}** (ID: ${c.charId})`).join('\n');
        await i.reply({ content: `Monitoring ${chars.length} character(s):\n${list}`, flags: 64 });
        break;
      }
      case 'remove': {
        const name = i.options.getString('name');
        const chars = users[user.id];
        if (!chars) return i.reply({ content: 'Nothing to remove.', flags: 64 });
        const idx = chars.findIndex(c => c.charName.toLowerCase() === name.toLowerCase());
        if (idx === -1) return i.reply({ content: `Not found: ${name}`, flags: 64 });
        chars.splice(idx, 1);
        saveUsers();
        await i.reply({ content: `Removed **${name}**.`, flags: 64 });
        break;
      }
      case 'resetpoll': {
        const chars = users[user.id] || [];
        if (!chars.length) return i.reply({ content: 'No characters linked.', flags: 64 });
        chars.forEach(c => c.lastPoll = new Date().toISOString());
        saveUsers();
        await i.reply({ content: `Poll timer reset for ${chars.length} character(s).`, flags: 64 });
        break;
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    if (!i.replied) await i.reply({ content: 'Error.', flags: 64 }).catch(() => {});
  }
});

// === OAUTH CALLBACK ===
app.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || !users[state]) return res.status(400).send('<h1>Invalid Link</h1><p>Run /setup again.</p>');
  const { verifier, userId, channelId } = users[state];
  delete users[state];
  try {
    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code,
        client_id: process.env.EVE_CLIENT_ID,
        code_verifier: verifier
      })
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error('No access token');
    const payload = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString());
    const charId = parseInt(payload.sub.split(':')[2]);
    const charRes = await fetch(`${ESI_BASE}/characters/${charId}/`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const charData = await charRes.json();
    const charName = charData.name;
    if (!users[userId]) users[userId] = [];
    let char = users[userId].find(c => c.charId === charId);
    if (char) {
      Object.assign(char, {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + tokens.expires_in * 1000,
        lastPoll: new Date().toISOString(),
        trackedContracts: char.trackedContracts || []
      });
    } else {
      users[userId].push({
        charId, charName,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + tokens.expires_in * 1000,
        channelId,
        lastPoll: new Date().toISOString(),
        trackedContracts: []
      });
    }
    saveUsers();
    const channel = await client.channels.fetch(channelId);
    await channel.send(`**${charName}** linked! Use /status.`);
    res.send(`<h1>Success!</h1><p>${charName} is now linked. Close tab.</p>`);
  } catch (err) {
    console.error('Auth error:', err);
    res.status(500).send('<h1>Failed</h1><p>Try /setup again.</p>');
  }
});

// === POLLING LOOP ===
setInterval(async () => {
  for (const [userId, chars] of Object.entries(users)) {
    if (!Array.isArray(chars)) continue;
    for (const char of chars) {
      if (Date.now() > char.expires_at) {
        try { await refreshToken(char); saveUsers(); } catch (e) { console.error('Refresh failed for', char.charName, e); continue; }
      }
      try {
        const res = await fetch(`${ESI_BASE}/characters/${char.charId}/contracts/?datasource=tranquility`, { headers: { Authorization: `Bearer ${char.access_token}` } });
        if (!res.ok) { console.error(`Contracts fetch failed: HTTP ${res.status}`); continue; }
        const activeContracts = await res.json();
        if (!Array.isArray(char.trackedContracts)) char.trackedContracts = [];
        const trackedIds = char.trackedContracts.map(c => c.id);
        const newIssued = activeContracts.filter(c => c.status === 'outstanding' && !trackedIds.includes(c.contract_id));
        newIssued.forEach(c => char.trackedContracts.push({ id: c.contract_id, title: c.title || '—', issued: c.date_issued, status: 'outstanding' }));
        const updates = [];
        for (const tracked of char.trackedContracts) {
          const active = activeContracts.find(c => c.contract_id === tracked.id);
          if (!active) {
            if (['outstanding', 'in_progress'].includes(tracked.status)) {
              try {
                const detailRes = await fetch(`${ESI_BASE}/characters/${char.charId}/contracts/${tracked.id}/?datasource=tranquility`, { headers: { Authorization: `Bearer ${char.access_token}` } });
                if (detailRes.ok) {
                  const detail = await detailRes.json();
                  if (detail.status === 'finished') updates.push({ ...tracked, status: 'finished', time: detail.date_completed });
                  else if (detail.status === 'rejected') updates.push({ ...tracked, status: 'rejected', time: detail.date_expired });
                }
              } catch (e) { updates.push({ ...tracked, status: 'finished', time: new Date().toISOString() }); }
              char.trackedContracts = char.trackedContracts.filter(t => t.id !== tracked.id);
            }
            continue;
          }
          if (tracked.status === 'outstanding' && active.status === 'in_progress') {
            updates.push({ ...tracked, status: 'accepted', time: active.date_accepted });
            tracked.status = 'in_progress';
          }
        }
        if (updates.length > 0) {
          const channel = await client.channels.fetch(char.channelId);
          for (const u of updates) {
            let title = '', color = 0x000000, statusText = '';
            if (u.status === 'accepted') { title = 'Contract Accepted!'; color = 0x0099ff; statusText = 'Accepted'; }
            else if (u.status === 'finished') { title = 'Contract Completed!'; color = 0x00ff00; statusText = 'Finished'; }
            else if (u.status === 'rejected') { title = 'Contract Rejected!'; color = 0xff0000; statusText = 'Rejected'; }
            const embed = new EmbedBuilder().setTitle(title).setDescription(`**${char.charName}**`).addFields(
              { name: 'Status', value: statusText, inline: true },
              { name: 'ID', value: `${u.id}`, inline: true },
              { name: 'Title', value: u.title, inline: false },
              { name: 'Time', value: `<t:${Math.floor(new Date(u.time).getTime()/1000)}:F>`, inline: false }
            ).setColor(color);
            await channel.send({ content: `<@${userId}>`, embeds: [embed] });
          }
        }
        saveUsers();
      } catch (e) { console.error('Poll error:', e); }
    }
  }
}, 5 * 60 * 1000);

// === STARTUP TOKEN REFRESH ===
setTimeout(async () => {
  for (const [userId, chars] of Object.entries(users)) {
    if (!Array.isArray(chars)) continue;
    for (const char of chars) {
      if (Date.now() > char.expires_at) {
        try { await refreshToken(char); saveUsers(); } catch (e) { console.error('Startup refresh failed:', e); }
      }
    }
  }
}, 10000);

// === START SERVERS ===
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
client.login(process.env.DISCORD_TOKEN);
