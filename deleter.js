const http = require("http");

const TOKEN      = process.env.DISCORD_TOKEN || "YOUR_TOKEN_HERE";
const CHANNEL_ID = process.env.CHANNEL_ID    || "YOUR_CHANNEL_ID";
const MY_USER_ID = process.env.MY_USER_ID    || "";
const DELAY      = parseFloat(process.env.DELAY || "2.0") * 1000;

const BASE    = "https://discord.com/api/v9";
const HEADERS = {
  "Authorization": TOKEN,
  "Content-Type": "application/json"
};

const WEBHOOK = process.env.DISCORD_WEBHOOK || "YOUR_WEBHOOK_URL";

// keep alive server
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

function discordTimestamp(msFromNow) {
  return Math.floor((Date.now() + msFromNow) / 1000);
}

async function webhook(payload) {
  await fetch(WEBHOOK, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
}

async function fetchMessages(before = null) {
  const params = new URLSearchParams({ limit: 100 });

  if (before) params.append("before", before);

  const r = await fetch(
    `${BASE}/channels/${CHANNEL_ID}/messages?${params}`,
    { headers: HEADERS }
  );

  if (r.status === 429) {
    const data = await r.json();
    const wait = (data.retry_after || 5) * 1000;

    await sleep(wait);
    return fetchMessages(before);
  }

  return r.json();
}

async function deleteMessage(msgId) {
  while (true) {
    const r = await fetch(
      `${BASE}/channels/${CHANNEL_ID}/messages/${msgId}`,
      {
        method: "DELETE",
        headers: HEADERS
      }
    );

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

async function countMessages() {
  let before = null;
  let total = 0;

  while (true) {
    const messages = await fetchMessages(before);

    if (!messages.length) break;

    for (const msg of messages) {
      if (MY_USER_ID && msg.author.id !== MY_USER_ID) continue;

      total++;
    }

    before = messages[messages.length - 1].id;
  }

  return total;
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

async function notifyStart(total, eta) {
  const finish = discordTimestamp(eta);

  await webhook({
    embeds: [
      {
        title: "🧹 Message Cleanup Started",
        description:
          `Cleaning up <#${CHANNEL_ID}>.\n` +
          `I'll send another update when the job is completely finished.`,
        color: 0xF0B232,

        fields: [
          {
            name: "Messages",
            value: `**${total.toLocaleString()}**`,
            inline: true
          },
          {
            name: "Delay",
            value: `**${(DELAY / 1000).toFixed(1)}s** / message`,
            inline: true
          },
          {
            name: "ETA",
            value: `**${formatDuration(eta)}**`,
            inline: true
          },
          {
            name: "Expected Finish",
            value: `<t:${finish}:F>\n<t:${finish}:R>`,
            inline: false
          }
        ],

        footer: {
          text: "ETA may shift slightly if Discord applies rate limits."
        },

        timestamp: new Date().toISOString()
      }
    ]
  });
}

async function notifyFinish(deleted, elapsed) {
  await webhook({
    content: "@everyone",
    embeds: [
      {
        title: "✅ Message Cleanup Complete",
        description:
          `Finished cleaning <#${CHANNEL_ID}> successfully.`,

        color: 0x57F287,

        fields: [
          {
            name: "Messages Deleted",
            value: `**${deleted.toLocaleString()}**`,
            inline: true
          },
          {
            name: "Total Time",
            value: `**${formatDuration(elapsed)}**`,
            inline: true
          }
        ],

        footer: {
          text: "Cleanup finished"
        },

        timestamp: new Date().toISOString()
      }
    ]
  });
}

async function notifyError(err) {
  const message =
    String(err?.message || err || "Unknown error").slice(0, 1000);

  await webhook({
    embeds: [
      {
        title: "❌ Message Cleanup Failed",
        description:
          `Something stopped the cleanup in <#${CHANNEL_ID}>.\n\n` +
          `\`\`\`\n${message}\n\`\`\``,

        color: 0xED4245,

        timestamp: new Date().toISOString()
      }
    ]
  });
}

async function main() {
  let before  = null;
  let deleted = 0;

  // Count only the messages the existing deletion logic would target
  const total = await countMessages();

  /*
   * Base delay + small allowance for each Discord DELETE request.
   * Rate limiting is unpredictable, so no ETA can be literally exact.
   */
  const REQUEST_OVERHEAD = 200;
  const estimatedPerMessage = DELAY + REQUEST_OVERHEAD;
  const eta = total * estimatedPerMessage;

  await notifyStart(total, eta);

  const startedAt = Date.now();

  // original deletion logic
  while (true) {
    const messages = await fetchMessages(before);

    if (!messages.length) {
      const elapsed = Date.now() - startedAt;

      await notifyFinish(deleted, elapsed);
      await suspend();

      break;
    }

    for (const msg of messages) {
      before = msg.id;

      if (MY_USER_ID && msg.author.id !== MY_USER_ID) continue;

      const ok = await deleteMessage(msg.id);

      if (ok) {
        deleted++;
      }

      await sleep(DELAY);
    }
  }
}

main().catch(async err => {
  try {
    await notifyError(err);
  } catch {}
});
