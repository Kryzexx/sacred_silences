const http = require("http");

const TOKEN      = process.env.DISCORD_TOKEN || "YOUR_TOKEN_HERE";
const CHANNEL_ID = process.env.CHANNEL_ID    || "YOUR_CHANNEL_ID";
const MY_USER_ID = process.env.MY_USER_ID    || "";
const DELAY      = parseFloat(process.env.DELAY || "2.0") * 1000;

const BASE    = "https://discord.com/api/v9";
const HEADERS = { "Authorization": TOKEN, "Content-Type": "application/json" };

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

function formatFinishTime(ms) {
  return new Date(Date.now() + ms).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Asia/Tbilisi"
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

    console.log(`Rate limited on fetch, waiting ${wait}ms`);

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

      console.log(`Rate limited, waiting ${wait}ms`);

      await sleep(wait);
      continue;
    }

    if (r.status === 403) return false;

    console.log(`Unexpected ${r.status}, retrying...`);
    await sleep(2000);
  }
}

async function countMessages() {
  let before = null;
  let count = 0;

  while (true) {
    const messages = await fetchMessages(before);

    if (!messages.length) break;

    for (const msg of messages) {
      if (MY_USER_ID && msg.author.id !== MY_USER_ID) continue;
      count++;
    }

    before = messages[messages.length - 1].id;

    if (messages.length < 100) break;
  }

  return count;
}

async function suspend() {
  const SERVICE_ID = process.env.RENDER_SERVICE_ID || "YOUR_SERVICE_ID";
  const RENDER_KEY = process.env.RENDER_API_KEY    || "YOUR_API_KEY";

  await fetch(
    `https://api.render.com/v1/services/${SERVICE_ID}/suspend`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RENDER_KEY}`
      }
    }
  );

  console.log("Service suspended.");
}

async function notifyStart(total, eta) {
  const WEBHOOK = process.env.DISCORD_WEBHOOK || "YOUR_WEBHOOK_URL";

  await fetch(WEBHOOK, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      content:
        `🧹 **Message deletion started**\n\n` +
        `**Channel:** <#${CHANNEL_ID}>\n` +
        `**Messages:** ${total.toLocaleString()}\n` +
        `**Delay:** ${(DELAY / 1000).toFixed(1)}s per message\n` +
        `**Estimated time:** ${formatDuration(eta)}\n` +
        `**Estimated finish:** ${formatFinishTime(eta)}`
    })
  });
}

async function notify(deleted, elapsed) {
  const WEBHOOK = process.env.DISCORD_WEBHOOK || "YOUR_WEBHOOK_URL";

  await fetch(WEBHOOK, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      content:
        `@everyone ✅ **Message deletion complete**\n\n` +
        `**Channel:** <#${CHANNEL_ID}>\n` +
        `**Deleted:** ${deleted.toLocaleString()} messages\n` +
        `**Time taken:** ${formatDuration(elapsed)}`
    })
  });
}

async function main() {
  let before  = null;
  let deleted = 0;

  console.log(`Counting messages — channel ${CHANNEL_ID}`);

  const total = await countMessages();

  // Small allowance for API request time on top of the configured delay.
  // Discord rate limits can still make the real runtime longer.
  const estimatedPerMessage = DELAY + 150;
  const eta = total * estimatedPerMessage;

  await notifyStart(total, eta);

  console.log(
    `Starting deletion — ${total} messages — ETA ${formatDuration(eta)}`
  );

  const startedAt = Date.now();

  while (true) {
    const messages = await fetchMessages(before);

    if (!messages.length) {
      const elapsed = Date.now() - startedAt;

      console.log(
        `Done. Deleted ${deleted} messages in ${formatDuration(elapsed)}.`
      );

      await notify(deleted, elapsed);
      await suspend();
      break;
    }

    for (const msg of messages) {
      before = msg.id;

      if (MY_USER_ID && msg.author.id !== MY_USER_ID) continue;

      const ok = await deleteMessage(msg.id);

      if (ok) {
        deleted++;
        console.log(`[${deleted}/${total}] deleted ${msg.id}`);
      }

      await sleep(DELAY);
    }
  }
}

main().catch(console.error);
