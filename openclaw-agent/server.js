/**
 * OpenClaw Agent Server
 *
 * Express server that exposes the agentic chat API.
 * Integrates with the voice companion via /api/chat endpoint.
 *
 * Run: node server.js
 * Port: 8080 (configurable via PORT env)
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { runAgent, TOOLS, postProcess } = require('./lib/agent');
const { startCleanup } = require('./lib/functions/reminders');
const { ping: memPing } = require('./lib/memory/tidb_mem9');
const { groqChat } = require('./lib/groq');

const app = express();
const PORT = parseInt(process.env.PORT || '8080', 10);

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS || '*',
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Request logging ────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// ── Health check ──────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const mem = await memPing();
  const groq = process.env.GROQ_API_KEY ? 'configured' : 'missing';

  res.json({
    status: 'ok',
    service: 'openclaw-agent',
    uptime: Math.floor(process.uptime()),
    memory: mem,
    groq: groq,
    tools: TOOLS.map(t => t.name),
    version: '2.0.0',
  });
});

// ── Tool definitions ────────────────────────────────────────────────────────
app.get('/api/tools', (req, res) => {
  res.json({ tools: TOOLS });
});

// ── Main chat endpoint ─────────────────────────────────────────────────────
/**
 * POST /api/chat
 * Body: { userId: string, message: string, history?: Array, stream?: boolean }
 * Response: { response: string, toolCalls: Array, userId: string }
 */
app.post('/api/chat', async (req, res) => {
  const { userId, message, history = [], stream = false } = req.body;

  if (!userId || !message) {
    return res.status(400).json({
      error: 'Missing required fields: userId and message',
    });
  }

  if (message.trim().length < 1) {
    return res.status(400).json({ error: 'Message is empty' });
  }

  if (message.length > 10000) {
    return res.status(400).json({ error: 'Message too long (max 10000 chars)' });
  }

  console.log(`[Chat] ${userId}: "${message.substring(0, 100)}"`);

  try {
    const result = await runAgent(userId, message, history);

    // Post-process: extract profile facts, detect habits
    postProcess(userId, message, result.response).catch(console.error);

    console.log(`[Chat] ${userId} → "${result.response.substring(0, 100)}" (${result.toolCalls.length} tools)`);
    console.log(`[Chat] Proactive: ${result.proactive || 'none'}`);

    res.json({
      userId,
      response: result.response,
      proactive: result.proactive || null,
      toolCalls: result.toolCalls.map(c => ({ tool: c.tool, args: c.args })),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[Chat] Error for ${userId}:`, err);
    res.status(500).json({
      error: 'Agent error: ' + err.message,
      userId,
    });
  }
});

// ── Streaming chat endpoint ─────────────────────────────────────────────────
/**
 * POST /api/chat/stream
 * Body: { userId, message, history? }
 * Response: text/event-stream
 */
app.post('/api/chat/stream', async (req, res) => {
  const { userId, message, history = [] } = req.body;

  if (!userId || !message) {
    return res.status(400).json({ error: 'Missing userId or message' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const result = await runAgent(userId, message, history);

    // Post-process (async, don't wait)
    postProcess(userId, message, result.response).catch(console.error);

    // Stream word by word
    const words = result.response.split(' ');
    for (const word of words) {
      res.write(`data: ${JSON.stringify({ type: 'word', text: word + ' ' })}\n\n`);
      // Small delay to simulate natural speech
      await new Promise(r => setTimeout(r, 30));
    }

    res.write(`data: ${JSON.stringify({ type: 'done', toolCalls: result.toolCalls })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[Stream] Error:', err);
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    res.end();
  }
});

// ── Reminder callbacks endpoint ─────────────────────────────────────────────
/**
 * POST /api/reminders/subscribe
 * Body: { userId: string, callbackUrl: string }
 * → Register a URL to call when a reminder fires for this user
 */
const reminderCallbacks = new Map(); // userId → callbackUrl

app.post('/api/reminders/subscribe', (req, res) => {
  const { userId, callbackUrl } = req.body;
  if (!userId || !callbackUrl) {
    return res.status(400).json({ error: 'Missing userId or callbackUrl' });
  }
  reminderCallbacks.set(userId, callbackUrl);
  res.json({ success: true, message: `Subscribed reminders for ${userId}` });
});

app.delete('/api/reminders/subscribe/:userId', (req, res) => {
  reminderCallbacks.delete(req.params.userId);
  res.json({ success: true });
});

// ── Memory management ──────────────────────────────────────────────────────
app.get('/api/memory/:userId', async (req, res) => {
  const { userId } = req.params;
  const { query, limit = 10 } = req.query;

  const { vectorSearch } = require('./lib/memory/tidb_mem9');
  try {
    const results = query
      ? await vectorSearch(userId, query, parseInt(limit))
      : await require('./lib/memory/tidb_mem9').fulltextSearch(userId, "", parseInt(limit));
    res.json({ userId, memories: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/memory/:userId', async (req, res) => {
  const { userId } = req.params;
  const { content, key, confidence = 0.8 } = req.body;

  if (!content) return res.status(400).json({ error: 'Missing content' });

  const { upsertMemoryWithEmbedding } = require('./lib/memory/tidb_mem9');
  const result = await upsertMemoryWithEmbedding(userId, content, key, 'both', confidence);
  res.json({ success: result.success, error: result.error });
});

// ── Embed all memories endpoint ─────────────────────────────────────────────
app.post('/api/memory/:userId/embed-all', async (req, res) => {
  const { userId } = req.params;
  const { embedAllMemories } = require('./lib/memory/tidb_mem9');
  const result = await embedAllMemories(userId);
  res.json({ userId, ...result });
});

// ── LLM playground ─────────────────────────────────────────────────────────
app.post('/api/llm', async (req, res) => {
  const { messages, model, temperature } = req.body;
  if (!messages) return res.status(400).json({ error: 'Missing messages' });

  try {
    const result = await groqChat(messages, { model, temperature });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 404 handler ───────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ── Error handler ─────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Server Error]:', err);
  res.status(500).json({ error: 'Internal server error: ' + err.message });
});

// ── Boot ──────────────────────────────────────────────────────────────────
async function boot() {
  // Test memory connection
  const mem = await memPing();
  if (mem.ok) {
    console.log('> TiDB Mem9: connected');
  } else {
    console.warn('> TiDB Mem9: not connected —', mem.error);
    console.warn('  Memory features will use FULLTEXT fallback or be disabled.');
  }

  // Start reminder cleanup
  startCleanup();
  console.log('> Reminders: cleanup scheduler started');

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n> OpenClaw Agent v2 ready on http://0.0.0.0:${PORT}`);
    console.log(`> Endpoints:`);
    console.log(`  POST /api/chat          — main agentic chat`);
    console.log(`  POST /api/chat/stream   — streaming response`);
    console.log(`  GET  /api/tools         — available tools`);
    console.log(`  GET  /health            — health check`);
    console.log(`  GET  /api/memory/:uid   — search memories`);
    console.log(`  POST /api/memory/:uid   — save memory\n`);
  });
}

boot().catch(console.error);
