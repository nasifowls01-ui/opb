import { Client, GatewayIntentBits, Collection } from "discord.js";
import { config } from "dotenv";
import { connectDB } from "./config/database.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

config();
await connectDB();

// Build intents. MessageContent is required for prefix message commands.
// Make sure you've enabled it on the Discord Developer Portal for the bot.
const intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
];

const client = new Client({ intents });

client.commands = new Collection();

// Startup diagnostics: show configured intents and remind to enable Message Content
console.log('Configured gateway intents:', intents.map(i => i && i.toString ? i.toString() : i));
if (!intents.includes(GatewayIntentBits.MessageContent)) {
  console.warn('⚠️ Message Content intent is NOT included in the client setup. Message-based commands will NOT work unless this intent is enabled and also allowed in the Bot settings in the Discord Developer Portal.');
} else {
  console.log('✅ Message Content intent is included in the client configuration. Make sure it is also enabled in the Discord Developer Portal.');
}

// dynamically load commands
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const commandFiles = fs.readdirSync("./commands").filter(file => file.endsWith(".js"));

for (const file of commandFiles) {
  const imported = await import(`./commands/${file}`);
  const command = imported.default || imported; // normalize default vs named exports
  // compute a safe command name (lowercased) from the SlashCommandBuilder
  let cmdName;
  try {
    cmdName = (command.data && command.data.name) || (command.data && command.data.toJSON && command.data.toJSON().name) || file.replace(/\.js$/, "");
  } catch (e) {
    cmdName = file.replace(/\.js$/, "");
  }
  client.commands.set(String(cmdName).toLowerCase(), command);
  // register aliases if provided by the command module (e.g. ['inv','inventory'])
  if (command.aliases && Array.isArray(command.aliases)) {
    for (const a of command.aliases) {
      client.commands.set(String(a).toLowerCase(), command);
    }
  }
}

// Diagnostics: log loaded commands
console.log(`Loaded ${client.commands.size} command entries (including aliases).`);
console.log('Command keys:', [...client.commands.keys()].slice(0, 50).join(', '));
// simple message-based prefix handling: prefix is "op" (case-insensitive)
client.on("messageCreate", async (message) => {
  try {
    // Diagnostics: log incoming messages (truncated) so you can confirm the bot receives them in Render logs
    const preview = (message.content || '').slice(0, 200).replace(/\n/g, ' ');
    console.log(`messageCreate from ${message.author?.tag || message.author?.id} (bot=${message.author?.bot}) preview="${preview}"`);

    if (!message.content) return;
    if (message.author?.bot) return;

    const parts = message.content.trim().split(/\s+/);
    if (parts.length < 2) return;

    // prefix is the first token; must be 'op' case-insensitive
    if (parts[0].toLowerCase() !== "op") return;

    const commandName = parts[1].toLowerCase();
    const command = client.commands.get(commandName);

    if (!command) {
      console.log(`Unknown message command requested: ${commandName}`);
      return;
    }

    // call the same execute exported for slash commands; pass message and client
    await command.execute(message, client);
  } catch (err) {
    console.error("Error handling message command:", err);
  }
});

// dynamically load events
const eventFiles = fs.readdirSync("./events").filter(file => file.endsWith(".js"));

for (const file of eventFiles) {
  const event = await import(`./events/${file}`);
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args, client));
  } else {
    client.on(event.name, (...args) => event.execute(...args, client));
  }
}

// Start a small HTTP server FIRST so Render and uptime monitors (e.g., UptimeRobot)
// can check that the service is alive even if Discord login hangs. This avoids
// adding express as a dependency and works with Render's $PORT environment variable.
import http from "http";

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/health" || req.url === "/_health")) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("OK");
  }

  if (req.method === "GET" && req.url === "/status") {
    const payload = {
      status: "ok",
      port: PORT,
      discord: client.user ? `${client.user.tag}` : null,
      discord_logged_in: !!client.user,
      gateway_mode: globalThis.GATEWAY_MODE || (client.user ? 'connected' : 'disconnected'),
      discord_uptime_ms: client.uptime || null,
      uptimeSeconds: Math.floor(process.uptime()),
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(payload));
  }

  // Interactions endpoint: used when running as a web service without a gateway connection
  if (req.method === "POST" && req.url === "/interactions") {
    // Read raw body
    let body = "";
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        // signature verification requires DISCORD_PUBLIC_KEY
        const sig = req.headers['x-signature-ed25519'];
        const ts = req.headers['x-signature-timestamp'];
        if (!sig || !ts || !process.env.DISCORD_PUBLIC_KEY) {
          console.warn('Interaction received but verification could not be performed (missing headers or DISCORD_PUBLIC_KEY).');
          res.writeHead(401);
          return res.end('invalid request');
        }

        const verifyResult = await (async () => {
          try {
            const nacl = await import('tweetnacl');
            const msg = Buffer.concat([Buffer.from(ts, 'utf8'), Buffer.from(body, 'utf8')]);
            const sigBuf = Buffer.from(sig, 'hex');
            const pubKey = Buffer.from(process.env.DISCORD_PUBLIC_KEY, 'hex');
            return nacl.sign.detached.verify(msg, sigBuf, pubKey);
          } catch (e) {
            console.error('Error during signature verification:', e && e.message ? e.message : e);
            return false;
          }
        })();

        if (!verifyResult) {
          console.warn('⚠️ Interaction signature verification failed.');
          res.writeHead(401);
          return res.end('invalid signature');
        }

        const payload = JSON.parse(body);
        // PING
        if (payload.type === 1) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ type: 1 }));
        }

        // Only handle APPLICATION_COMMAND (2)
        if (payload.type === 2 && payload.data && payload.data.name) {
          const name = payload.data.name.toLowerCase();
          const cmd = client.commands.get(name);
          if (!cmd) {
            console.warn('Received interaction for unknown command:', name);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ type: 4, data: { content: 'Command not found', flags: 64 } }));
          }

          // Build a minimal Interaction-like object compatible with our command handlers
          const interaction = {
            id: payload.id,
            token: payload.token,
            user: payload.member?.user || payload.user,
            isCommand: () => true,
            isChatInputCommand: () => true,
            options: {
              getString: (n) => {
                const opt = (payload.data.options || []).find(o => o.name === n);
                return opt ? opt.value : null;
              },
              getInteger: (n) => {
                const opt = (payload.data.options || []).find(o => o.name === n);
                return opt ? parseInt(opt.value, 10) : null;
              },
              // add other getters as needed
            },
            reply: async (resp) => {
              // Convert discord.js-style reply into raw interaction response
              const data = {};
              if (typeof resp === 'string') data.content = resp;
              else if (resp && resp.content) data.content = resp.content;
              else if (resp && resp.embeds) data.embeds = resp.embeds;
              if (resp && resp.flags) data.flags = resp.flags;

              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ type: 4, data }));
            }
          };

          try {
            // execute command; commands may call interaction.reply which we handle above
            await cmd.execute(interaction, client);
            // If the command didn't call reply directly, send a default ack
            // (some commands might already have replied) — send nothing here to avoid double response.
          } catch (e) {
            console.error('Error executing command for interaction:', e && e.message ? e.message : e);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ type: 4, data: { content: 'Internal error', flags: 64 } }));
          }

          return;
        }

        // Other interaction types: just acknowledge
        res.writeHead(200);
        res.end();
      } catch (err) {
        console.error('Error handling interaction:', err && err.message ? err.message : err);
        res.writeHead(500);
        res.end('server error');
      }
    });

    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => console.log(`Health server listening on port ${PORT}`));

// Start an optional "dummy" server on port 3000 (or override with DUMMY_PORT).
// This is useful on hosts that expect an app to bind a fixed port even if the
// main service uses the platform-assigned $PORT. The dummy server tolerates
// port-in-use errors so it won't crash the process.
const DUMMY_PORT = Number(process.env.DUMMY_PORT || 3000);
const dummyServer = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/dummy' || req.url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('OK - dummy');
  }
  res.writeHead(404);
  res.end();
});

dummyServer.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.warn(`Dummy server port ${DUMMY_PORT} is already in use; skipping dummy server.`);
  } else {
    console.error('Dummy server error:', err);
  }
});

dummyServer.listen(DUMMY_PORT, () => console.log(`Dummy server listening on port ${DUMMY_PORT}`));

// Optional: auto-register slash commands if explicitly enabled
if (process.env.REGISTER_COMMANDS_ON_START === 'true') {
  (async () => {
    try {
      console.log('REGISTER_COMMANDS_ON_START is true: importing deploy-commands.js to register slash commands...');
      await import('./deploy-commands.js');
      console.log('Slash command registration attempt finished.');
    } catch (err) {
      console.error('Error while auto-registering commands:', err && err.message ? err.message : err);
    }
  })();
}

// Ensure we have a token and make login failures visible in Render logs
if (!process.env.TOKEN) {
  console.error("❌ TOKEN is not set in environment variables. Set TOKEN in your Render service settings.");
  // Keep the process alive so you can inspect the service; don't exit immediately
} else {
  console.log(`Found TOKEN of length ${process.env.TOKEN.length} characters — performing pre-login checks...`);

  // Diagnostic helpers: check DNS and the Discord REST API for token validity.
  const { lookup } = await import('dns/promises');

  const checkDiscordReachable = async () => {
    try {
      const addresses = await lookup('discord.com');
      console.log('✅ DNS lookup for discord.com succeeded:', addresses);
      return { ok: true };
    } catch (err) {
      console.error('❌ DNS lookup for discord.com failed:', err && err.message ? err.message : err);
      return { ok: false, error: err };
    }
  };

  // helper sleep
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  // If you want to skip REST checks that may rate limit you, set DISABLE_REST_CHECK=true in env
  const DISABLE_REST_CHECK = process.env.DISABLE_REST_CHECK === 'true';
  if (DISABLE_REST_CHECK) console.log('DISABLE_REST_CHECK=true — skipping REST token validation to avoid rate limits');

  const checkTokenRestWithRetries = async (token, maxAttempts = 3) => {
    if (DISABLE_REST_CHECK) return { ok: true, skipped: true };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const resp = await fetch('https://discord.com/api/v10/users/@me', {
          headers: { Authorization: `Bot ${token}` },
          method: 'GET',
        });

        if (resp.status === 200) {
          const body = await resp.json();
          console.log('✅ Token REST check succeeded, bot:', body.username ? `${body.username}#${body.discriminator || '????'}` : body);
          return { ok: true, body };
        }

        if (resp.status === 401) {
          console.error('❌ Token REST check failed: 401 Unauthorized — invalid token');
          return { ok: false, error: 'invalid_token', status: 401 };
        }

        if (resp.status === 429) {
          // Rate limited; try to read retry_after but DON'T block startup by waiting multiple retries here.
          let retryAfterMs = 0;
          try {
            const json = await resp.json();
            const retryAfter = json && (json.retry_after || json.retry_after_ms || json.retryAfter);
            if (typeof retryAfter === 'number') retryAfterMs = Math.ceil(retryAfter * 1000);
          } catch (e) {
            // ignore
          }
          const headerRetry = resp.headers.get('retry-after');
          if (headerRetry && !retryAfterMs) {
            const h = Number(headerRetry);
            if (!Number.isNaN(h)) retryAfterMs = Math.ceil(h * 1000);
          }
          console.warn(`⚠️ Token REST check returned 429 (rate limited). Not retrying further here to avoid startup delay. Retry-After: ${retryAfterMs}ms`);
          return { ok: false, status: 429, error: 'rate_limited', retryAfterMs };
        }

        console.error('❌ Token REST check returned status', resp.status);
        return { ok: false, status: resp.status };
      } catch (err) {
        console.error('❌ Token REST check threw an error (attempt ' + attempt + '):', err && err.message ? err.message : err);
        if (attempt < maxAttempts) {
          const backoff = Math.ceil(2000 * Math.pow(2, attempt - 1));
          await sleep(backoff);
          continue;
        }
        return { ok: false, error: err };
      }
    }
    return { ok: false, error: 'rate_limited' };
  };

  const loginWithRetries = async (token, attempts = 3) => {
    for (let i = 1; i <= attempts; i++) {
      try {
        console.log(`Websocket login attempt ${i}/${attempts}`);
        await Promise.race([
          client.login(token),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Discord login timed out')), 60000)),
        ]);
        return { ok: true };
      } catch (err) {
        console.error(`Login attempt ${i} failed:`, err && err.message ? err.message : err);
        if (i < attempts) {
          const wait = Math.ceil(5000 * Math.pow(2, i - 1));
          console.log(`Waiting ${wait}ms before retrying login...`);
          await sleep(wait);
          continue;
        }
        return { ok: false, error: err };
      }
    }
  };

  (async () => {
    const dnsRes = await checkDiscordReachable();
    const tokenRes = await checkTokenRestWithRetries(process.env.TOKEN, 3);

    if (!dnsRes.ok) {
      console.error('Network/DNS check failed — outbound network to discord.com may be blocked from this environment.');
    }

    if (!tokenRes.ok) {
      if (tokenRes.error === 'invalid_token' || tokenRes.status === 401) {
        console.error('❌ The provided TOKEN is invalid. Rotate the bot token and update Render environment variables.');
        process.exit(1);
      }
      if (tokenRes.error === 'rate_limited' || tokenRes.status === 429) {
        console.warn('⚠️ Token REST check is being rate limited. Proceeding to websocket login attempts immediately to avoid startup delay. Consider setting DISABLE_REST_CHECK=true to skip REST checks on startup.');
      } else {
        console.error('Token REST check failed:', tokenRes);
      }
    }

    // Add more event diagnostics for connection issues
    client.on('error', (err) => console.error('client error:', err));
    client.on('shardError', (err) => console.error('shard error:', err));
    client.on('shardDisconnect', (event, shardId) => console.warn('shard disconnect:', { event, shardId }));

    // WebSocket connectivity test
    const testWebsocketOnce = async () => {
      try {
        const { WebSocket } = await import('ws');
        return await new Promise((resolve) => {
          let settled = false;
          const ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
          const cleanup = () => { try { ws.terminate(); } catch (e) {} };
          const finish = (ok, msg) => { if (settled) return; settled = true; cleanup(); resolve({ ok, msg }); };
          ws.on('open', () => finish(true, 'WS open'));
          ws.on('message', (m) => {/* ignore messages */});
          ws.on('error', (e) => finish(false, e && e.message ? e.message : String(e)));
          ws.on('close', (code, reason) => finish(false, `WS closed: ${code} ${reason ? reason.toString().slice(0,100) : ''}`));
          setTimeout(() => finish(false, 'WS test timeout'), 10000);
        });
      } catch (e) {
        console.error('WS test import error:', e && e.message ? e.message : e);
        return { ok: false, msg: e && e.message ? e.message : e };
      }
    };

    // background login loop with exponential backoff and respect for Retry-After when available
    const maxBackoff = 60 * 60 * 1000; // 1 hour
    const base = 5000;
    let attempt = 0;
    let lastRetryAfter = tokenRes && tokenRes.retryAfterMs ? tokenRes.retryAfterMs : 0;

    if (process.env.DISABLE_GATEWAY === 'true' || process.env.INTERACTIONS_ONLY === 'true') {
      console.log('DISABLE_GATEWAY/INTERACTIONS_ONLY is set — skipping Discord gateway login and running in interactions-only mode.');
      globalThis.GATEWAY_MODE = 'disabled';
      return;
    }

    // Optional initial delay before attempting gateway login. Useful for hosts like Render
    // where networking or other services may not be fully ready immediately after process start.
    const STARTUP_LOGIN_DELAY_MS = Number(process.env.STARTUP_LOGIN_DELAY_MS) || 5000;
    if (STARTUP_LOGIN_DELAY_MS > 0) {
      console.log(`Delaying gateway login by ${STARTUP_LOGIN_DELAY_MS}ms to allow environment to settle...`);
      await sleep(STARTUP_LOGIN_DELAY_MS);
    }

    // Additional diagnostics to help Render debugging
    client.on('warn', (w) => console.warn('client warn:', w));
    process.on('unhandledRejection', (r) => console.error('unhandledRejection:', r));
    process.on('uncaughtException', (err) => console.error('uncaughtException:', err));

    (async function gatewayLoop(){
      while (true) {
        attempt++;
        try {
          console.log(`Gateway attempt ${attempt}: performing WS connectivity check...`);
          const wsRes = await testWebsocketOnce();
          if (!wsRes.ok) console.warn('WS connectivity test failed:', wsRes.msg);
          else console.log('WS connectivity test success');

          globalThis.GATEWAY_MODE = 'connecting';
          console.log(`Attempting gateway login (attempt ${attempt})...`);
          await Promise.race([
            client.login(process.env.TOKEN),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Discord login timed out')), 60000)),
          ]);
          console.log('✅ Discord login initiated — waiting for ready event...');
          return; // success
        } catch (err) {
          console.error(`Gateway login attempt ${attempt} failed:`, err && err.message ? err.message : err);
          globalThis.GATEWAY_MODE = 'failed';
          // determine wait time
          let wait = Math.ceil(base * Math.pow(2, Math.min(attempt - 1, 6)));
          if (lastRetryAfter && lastRetryAfter > wait) wait = lastRetryAfter;
          if (wait > maxBackoff) wait = maxBackoff;
          console.log(`Waiting ${wait}ms before next gateway attempt...`);
          await sleep(wait);
          // Refresh token REST info to catch updated Retry-After if any
          try {
            const fresh = await checkTokenRestWithRetries(process.env.TOKEN, 1);
            if (fresh && fresh.retryAfterMs) lastRetryAfter = fresh.retryAfterMs;
          } catch (e) {}
          continue;
        }
      }
    })();
  })();
}
