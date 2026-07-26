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

async function fetchMessages(before = null) {
  const params = new URLSearchParams({ limit: 100 });
  if (before) params.append("before", before);

  const r = await fetch(`${BASE}/channels/${CHANNEL_ID}/messages?${params}`, { headers: HEADERS });
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
    const r = await fetch(`${BASE}/channels/${CHANNEL_ID}/messages/${msgId}`, {
      method: "DELETE",
      headers: HEADERS
    });
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

async function main() {
  let before  = null;
  let deleted = 0;

  console.log(`Starting deletion — channel ${CHANNEL_ID}`);

  while (true) {
    const messages = await fetchMessages(before);

    if (!messages.length) {
      console.log(`Done. Deleted ${deleted} messages.`);
      break;
    }

    for (const msg of messages) {
      before = msg.id;

      if (MY_USER_ID && msg.author.id !== MY_USER_ID) continue;

      const ok = await deleteMessage(msg.id);
      if (ok) {
        deleted++;
        console.log(`[${deleted}] deleted ${msg.id}`);
      }

      await sleep(DELAY);
    }
  }
}

main().catch(console.error);
