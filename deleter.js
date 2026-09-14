const http = require("http");

const TOKEN = process.env.DISCORD_TOKEN || "YOUR_TOKEN_HERE";
const CHANNEL_ID = process.env.CHANNEL_ID || "YOUR_CHANNEL_ID";
const MY_USER_ID = process.env.MY_USER_ID || "";
const DELAY = parseFloat(process.env.DELAY || "2.0") * 1000;
const BASE = "https://discord.com/api/v9";
const HEADERS = {
  "Authorization": TOKEN,
  "Content-Type": "application/json"
};

http.createServer((req, res) => res.end("alive")).listen(3000);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchMessages(before = null) {
  const params = new URLSearchParams({ limit: 100 });
  if (before) params.append("before", before);
  const r = await fetch(`${BASE}/channels/${CHANNEL_ID}/messages?${params}`, { headers: HEADERS });
  if (r.status === 429) {
    const data = await r.json();
    const wait = (data.retry_after || 5) * 1000;
    await sleep(wait);
    return fetchMessages(before);
  }
  const data = await r.json();
  if (!Array.isArray(data)) return [];
  return data;
}

async function deleteMessage(msgId) {
  while (true) {
    const r = await fetch(`${BASE}/channels/${CHANNEL_ID}/messages/${msgId}`, {
      method: "DELETE",
      headers: HEADERS
    });
    if (r.status === 204) return true;
    if (r.status === 429) {
      const data = await r.json();
      const wait = (data.retry_after || 5) * 1000;
      await sleep(wait);
      continue;
    }
    if (r.status === 403) return false;
    await sleep(2000);
  }
}

async function getChannelInfo() {
  const r = await fetch(`${BASE}/channels/${CHANNEL_ID}`, { headers: HEADERS });
  return r.json();
}

async function getMessageCount() {
  const r = await fetch(
    `${BASE}/channels/${CHANNEL_ID}/messages/search?author_id=${MY_USER_ID}&sort_by=timestamp&sort_order=desc&offset=0`,
    { headers: HEADERS }
  );
  const data = await r.json();
  return data.total_results || 0;
}

async function suspend() {
  const SERVICE_ID = process.env.RENDER_SERVICE_ID || "YOUR_SERVICE_ID";
  const RENDER_KEY = process.env.RENDER_API_KEY || "YOUR_API_KEY";
  await fetch(`https://api.render.com/v1/services/${SERVICE_ID}/suspend`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${RENDER_KEY}` }
  });
}

async function webhook(payload) {
  const WEBHOOK = process.env.DISCORD_WEBHOOK || "YOUR_WEBHOOK_URL";
  await fetch(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

async function main() {
  let before = null;
  let deleted = 0;

  const channel = await getChannelInfo();
  const channelName = channel.name
    ? `#${channel.name}`
    : `DM with ${channel.recipients?.[0]?.global_name || channel.recipients?.[0]?.username}`;

  const totalMessages = await getMessageCount();

  const msPerMessage = DELAY + 900;
  const etaMs = totalMessages * msPerMessage;
  const etaStr = formatDuration(etaMs);
  const finishTs = Math.floor((Date.now() + etaMs) / 1000);

  await webhook({
    embeds: [{
      content: "@everyone",
      color: 0x5865F2,
      title: "🧹 Message Cleanup Started",
      description: `Cleaning up ${channelName}.`,
      fields: [
        { name: "Messages",        value: totalMessages.toLocaleString(), inline: true },
        { name: "Delay",           value: `${(DELAY / 1000).toFixed(1)}s / message`, inline: true },
        { name: "ETA",             value: etaStr, inline: true },
        { name: "Expected Finish", value: `<t:${finishTs}:f> — <t:${finishTs}:R>`, inline: false }
      ],
      timestamp: new Date().toISOString()
    }]
  });

  const startTime = Date.now();

  while (true) {
    const messages = await fetchMessages(before);
    if (!messages.length) {
      const elapsed = Date.now() - startTime;

      await webhook({
        embeds: [{
          content: "@everyone",
          color: 0x57F287,
          title: "✅ Message Cleanup Complete @everyone",
          description: `Finished cleaning ${channelName} successfully.`,
          fields: [
            { name: "Messages Deleted", value: deleted.toLocaleString(), inline: true },
            { name: "Total Time",       value: formatDuration(elapsed),  inline: true }
          ],
          timestamp: new Date().toISOString()
        }]
      });

      await suspend();
      break;
    }

    for (const msg of messages) {
      before = msg.id;
      if (MY_USER_ID && msg.author.id !== MY_USER_ID) continue;
      const ok = await deleteMessage(msg.id);
      if (ok) deleted++;
      await sleep(DELAY);
    }
  }
}

main().catch(console.error);
