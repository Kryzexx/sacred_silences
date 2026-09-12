const http = require("http");

const TOKEN      = process.env.DISCORD_TOKEN || "YOUR_TOKEN_HERE";
const CHANNEL_ID = process.env.CHANNEL_ID    || "YOUR_CHANNEL_ID";
const DELAY      = parseFloat(process.env.DELAY || "2.0") * 1000;
const WEBHOOK    = process.env.DISCORD_WEBHOOK || "YOUR_WEBHOOK_URL";

const BASE    = "https://discord.com/api/v9";
const HEADERS = {
  "Authorization": TOKEN,
  "Content-Type": "application/json"
};

// Keep-alive server
http.createServer((req, res) => res.end("alive")).listen(3000);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function formatDuration(ms) {
  let seconds = Math.max(0, Math.round(ms / 1000));

  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;

  const minutes = Math.floor(seconds / 60);
  seconds %= 60;

  const parts = [];

  if (hours) parts.push(`${hours}h`);
  if (minutes || hours) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);

  return parts.join(" ");
}

function formatFinishTime(ms) {
  return new Date(Date.now() + ms).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Asia/Tbilisi"
  });
}

async function sendWebhook(content) {
  await fetch(WEBHOOK, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      content
    })
  });
}

async function request(url, options = {}) {
  while (true) {
    const start = Date.now();

    const r = await fetch(url, {
      ...options,
      headers: {
        ...HEADERS,
        ...(options.headers || {})
      }
    });

    const latency = Date.now() - start;

    if (r.status === 429) {
      const data = await r.json();
      const wait = (data.retry_after || 5) * 1000;

      await sleep(wait);
      continue;
    }

    return { r, latency };
  }
}

async function getChannelName() {
  const { r } = await request(
    `${BASE}/channels/${CHANNEL_ID}`
  );

  if (!r.ok) {
    return `Channel ${CHANNEL_ID}`;
  }

  const channel = await r.json();

  let name = channel.name || CHANNEL_ID;

  if (channel.guild_id) {
    const { r: guildResponse } = await request(
      `${BASE}/guilds/${channel.guild_id}`
    );

    if (guildResponse.ok) {
      const guild = await guildResponse.json();
      name = `${guild.name} / #${name}`;
    } else {
      name = `#${name}`;
    }
  }

  return name;
}

async function fetchMessages(before = null) {
  const params = new URLSearchParams({
    limit: 100
  });

  if (before) {
    params.append("before", before);
  }

  const { r, latency } = await request(
    `${BASE}/channels/${CHANNEL_ID}/messages?${params}`
  );

  if (!r.ok) {
    throw new Error(
      `Failed to fetch messages: HTTP ${r.status}`
    );
  }

  return {
    messages: await r.json(),
    latency
  };
}

async function countMessages() {
  let before = null;
  let count = 0;

  let totalFetchLatency = 0;
  let fetches = 0;

  while (true) {
    const { messages, latency } = await fetchMessages(before);

    totalFetchLatency += latency;
    fetches++;

    if (!messages.length) {
      break;
    }

    count += messages.length;

    before = messages[messages.length - 1].id;

    if (messages.length < 100) {
      break;
    }
  }

  return {
    count,
    averageRequestLatency:
      fetches > 0
        ? totalFetchLatency / fetches
        : 0
  };
}

async function deleteMessage(msgId) {
  while (true) {
    const { r } = await request(
      `${BASE}/channels/${CHANNEL_ID}/messages/${msgId}`,
      {
        method: "DELETE"
      }
    );

    if (r.status === 204) {
      return true;
    }

    if (r.status === 403 || r.status === 404) {
      return false;
    }

    await sleep(2000);
  }
}

async function suspend() {
  const SERVICE_ID =
    process.env.RENDER_SERVICE_ID || "YOUR_SERVICE_ID";

  const RENDER_KEY =
    process.env.RENDER_API_KEY || "YOUR_API_KEY";

  await fetch(
    `https://api.render.com/v1/services/${SERVICE_ID}/suspend`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RENDER_KEY}`
      }
    }
  );
}

async function main() {
  const channelName = await getChannelName();

  const {
    count,
    averageRequestLatency
  } = await countMessages();

  const estimatedPerMessage =
    DELAY + averageRequestLatency;

  const estimatedTotal =
    count * estimatedPerMessage;

  // START WEBHOOK
  await sendWebhook(
    `🚀 **Deletion started**\n\n` +
    `**Chat:** ${channelName}\n` +
    `**Messages:** ${count.toLocaleString()}\n` +
    `**Delay:** ${(DELAY / 1000).toFixed(2)}s\n` +
    `**ETA:** ${formatDuration(estimatedTotal)}\n` +
    `**Expected finish:** ${formatFinishTime(estimatedTotal)}`
  );

  const startedAt = Date.now();

  let before = null;
  let deleted = 0;

  while (true) {
    const { messages } = await fetchMessages(before);

    if (!messages.length) {
      break;
    }

    for (const msg of messages) {
      before = msg.id;

      const ok = await deleteMessage(msg.id);

      if (ok) {
        deleted++;
      }

      await sleep(DELAY);
    }
  }

  const elapsed = Date.now() - startedAt;

  // FINISH WEBHOOK
  await sendWebhook(
    `@everyone ✅ **Deletion complete!**\n\n` +
    `**Chat:** ${channelName}\n` +
    `**Deleted:** ${deleted.toLocaleString()} messages\n` +
    `**Actual time:** ${formatDuration(elapsed)}`
  );

  await suspend();
}

main().catch(async err => {
  try {
    await sendWebhook(
      `❌ **Deletion failed**\n\n` +
      `\`\`\`\n${err.stack || err.message || err}\n\`\`\``
    );
  } catch {}

  try {
    await suspend();
  } catch {}
});
