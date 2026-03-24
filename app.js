import express from 'express';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── In-memory store (resets on redeploy, good enough for now) ───
let config = {
  tone: 'warm and friendly',
  formality: 60,
  detail: 50,
  emoji: 20,
  customQAs: [
    { q: 'What are the office hours?', a: 'Our office is open Monday to Friday, 9am to 6pm.' },
    { q: 'Who do I contact for payroll questions?', a: 'Please email payroll@rentman.nl for any payroll questions.' }
  ]
};
let questionLog = [];
let escalationLog = [];

// ─── Confluence ───────────────────────────────────────────────────
async function getConfluenceContent(query) {
  const baseUrl = process.env.CONFLUENCE_BASE_URL;
  const email = process.env.CONFLUENCE_EMAIL;
  const token = process.env.CONFLUENCE_API_TOKEN;
  const spaceKey = process.env.CONFLUENCE_SPACE_KEY || 'PC';
  if (!baseUrl || !email || !token) return '';
  try {
    const auth = Buffer.from(`${email}:${token}`).toString('base64');
    const cql = `space="${spaceKey}" AND type=page AND text~"${query}"`;
    const searchUrl = `https://${baseUrl}/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=3&expand=body.storage`;
    const response = await fetch(searchUrl, { headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' } });
    if (!response.ok) return await getSpacePages(baseUrl, auth, spaceKey, query);
    const data = await response.json();
    if (!data.results || data.results.length === 0) return await getSpacePages(baseUrl, auth, spaceKey, query);
    return data.results.map(page => {
      const body = page.body?.storage?.value?.replace(/<[^>]+>/g, ' ')?.replace(/\s+/g, ' ')?.trim()?.slice(0, 2000) || '';
      return `Page: ${page.title}\n${body}`;
    }).join('\n\n---\n\n');
  } catch (err) {
    console.error('Confluence error:', err.message);
    return '';
  }
}

async function getSpacePages(baseUrl, auth, spaceKey, query) {
  try {
    const url = `https://${baseUrl}/wiki/rest/api/content?spaceKey=${spaceKey}&type=page&limit=10&expand=body.storage`;
    const response = await fetch(url, { headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' } });
    if (!response.ok) return '';
    const data = await response.json();
    if (!data.results || data.results.length === 0) return '';
    const keywords = query.toLowerCase().split(' ').filter(w => w.length > 3);
    const relevant = data.results.filter(page => keywords.some(kw => page.title.toLowerCase().includes(kw)));
    const pages = relevant.length > 0 ? relevant : data.results.slice(0, 3);
    return pages.map(page => {
      const body = page.body?.storage?.value?.replace(/<[^>]+>/g, ' ')?.replace(/\s+/g, ' ')?.trim()?.slice(0, 2000) || '';
      return `Page: ${page.title}\n${body}`;
    }).join('\n\n---\n\n');
  } catch (err) { return ''; }
}

// ─── Slack events ─────────────────────────────────────────────────
app.post('/slack/events', async (req, res) => {
  const { type, event } = req.body;
  if (type === 'url_verification') return res.json({ challenge: req.body.challenge });
  if (event?.type === 'app_mention' || event?.type === 'message') {
    if (event.bot_id || event.subtype) return res.sendStatus(200);
    res.sendStatus(200);
    const userMessage = event.text?.replace(/<@[A-Z0-9]+>/g, '').trim();
    if (!userMessage) return;
    console.log(`Received: "${userMessage}"`);

    const logEntry = { time: new Date().toISOString(), question: userMessage, answer: '', escalated: false, user: event.user || 'unknown' };

    try {
      const confluenceContent = await getConfluenceContent(userMessage);
      const customMatch = config.customQAs.find(qa => userMessage.toLowerCase().includes(qa.q.toLowerCase().split(' ').slice(0,3).join(' ')));

      const toneDesc = `You are a ${config.tone} HR assistant for Rentman. ` +
        (config.formality > 66 ? 'Use formal language. ' : config.formality < 33 ? 'Use casual, conversational language. ' : 'Use a semi-formal tone. ') +
        (config.detail > 66 ? 'Give thorough, detailed answers. ' : config.detail < 33 ? 'Keep answers very brief. ' : 'Keep answers concise. ') +
        (config.emoji > 50 ? 'Use emojis to make responses friendly. ' : 'Do not use emojis. ');

      let systemPrompt = toneDesc + `Answer employee questions about company policies, benefits, time off, onboarding, and HR topics.
If a question is sensitive (harassment, grievance, legal, health emergency), say: "I'm looping in the HR team who can help you directly."
If you cannot find a relevant answer, say: "I wasn't able to find a clear answer — I'm looping in the HR team to help you."`;

      if (customMatch) systemPrompt += `\n\nUse this specific answer for this question:\nQ: ${customMatch.q}\nA: ${customMatch.a}`;
      if (confluenceContent) systemPrompt += `\n\nKnowledge base:\n${confluenceContent}`;

      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      });

      const reply = message.content[0].text;
      logEntry.answer = reply;

      const isEscalation = reply.toLowerCase().includes('looping in the hr team');
      logEntry.escalated = isEscalation;
      if (isEscalation) escalationLog.unshift({ ...logEntry });

      questionLog.unshift(logEntry);
      if (questionLog.length > 200) questionLog = questionLog.slice(0, 200);

      await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: event.channel, text: reply, thread_ts: event.thread_ts || event.ts })
      });

    } catch (err) {
      console.error('Error:', err.message);
      logEntry.answer = 'Error';
      questionLog.unshift(logEntry);
      await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: event.channel, text: "Sorry, I'm having trouble right now. Please contact HR directly." })
      });
    }
  } else { res.sendStatus(200); }
});

// ─── Admin auth middleware ────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.set('WWW-Authenticate', 'Basic realm="HR Admin"').status(401).send('Authentication required');
  const [,b64] = auth.split(' ');
  const [,pass] = Buffer.from(b64, 'base64').toString().split(':');
  if (pass !== 'HRchatbotdashboard2000') return res.set('WWW-Authenticate', 'Basic realm="HR Admin"').status(401).send('Wrong password');
  next();
}

// ─── Admin API endpoints ──────────────────────────────────────────
app.get('/admin/data', requireAuth, (req, res) => res.json({ config, questionLog, escalationLog }));
app.post('/admin/config', requireAuth, (req, res) => {
  const { tone, formality, detail, emoji } = req.body;
  if (tone) config.tone = tone;
  if (formality !== undefined) config.formality = parseInt(formality);
  if (detail !== undefined) config.detail = parseInt(detail);
  if (emoji !== undefined) config.emoji = parseInt(emoji);
  res.json({ ok: true });
});
app.post('/admin/qa/add', requireAuth, (req, res) => {
  const { q, a } = req.body;
  if (q && a) config.customQAs.push({ q, a });
  res.json({ ok: true, qas: config.customQAs });
});
app.post('/admin/qa/delete', requireAuth, (req, res) => {
  const { index } = req.body;
  config.customQAs.splice(parseInt(index), 1);
  res.json({ ok: true, qas: config.customQAs });
});

// ─── Admin dashboard HTML ─────────────────────────────────────────
app.get('/admin', requireAuth, (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HR Bot Admin</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;color:#1a1a1a;font-size:14px}
  .sidebar{position:fixed;top:0;left:0;width:200px;height:100vh;background:#1a1a2e;padding:24px 0;display:flex;flex-direction:column;gap:2px}
  .logo{padding:0 20px 24px;font-size:15px;font-weight:600;color:#fff;display:flex;align-items:center;gap:8px}
  .logo-dot{width:8px;height:8px;border-radius:50%;background:#4A9BE8}
  .nav{padding:8px 20px;color:#aaa;cursor:pointer;border-radius:0;transition:background .15s;font-size:13px}
  .nav:hover,.nav.active{background:rgba(255,255,255,.08);color:#fff}
  .main{margin-left:200px;padding:32px}
  .page{display:none}.page.active{display:block}
  h1{font-size:20px;font-weight:600;margin-bottom:4px}
  .sub{color:#666;font-size:13px;margin-bottom:24px}
  .card{background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:20px;margin-bottom:16px}
  .card-title{font-size:14px;font-weight:600;margin-bottom:16px;display:flex;align-items:center;gap:8px}
  .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px}
  .stat{background:#f8f8f8;border-radius:8px;padding:16px}
  .stat-label{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
  .stat-val{font-size:24px;font-weight:600}
  label{font-size:12px;font-weight:500;color:#666;display:block;margin-bottom:5px}
  input[type=text],textarea,select{width:100%;padding:8px 12px;border:1px solid #e0e0e0;border-radius:8px;font-size:13px;font-family:inherit;outline:none}
  input[type=text]:focus,textarea:focus{border-color:#4A9BE8}
  input[type=range]{width:100%}
  .btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;font-size:13px;font-weight:500;border-radius:8px;cursor:pointer;border:1px solid #e0e0e0;background:#fff;color:#1a1a1a;transition:background .15s}
  .btn:hover{background:#f5f5f5}
  .btn-primary{background:#1a1a2e;color:#fff;border-color:transparent}
  .btn-primary:hover{opacity:.85}
  .btn-danger{color:#dc2626;border-color:#fecaca}
  .btn-danger:hover{background:#fef2f2}
  .tone-row{display:flex;align-items:center;gap:12px;margin-bottom:14px}
  .tone-label{width:90px;font-size:13px;font-weight:500;flex-shrink:0}
  .tone-ends{display:flex;justify-content:space-between;font-size:11px;color:#999;margin-top:2px}
  .preview-box{background:#f8f8f8;border-radius:8px;padding:12px;font-size:13px;line-height:1.6;color:#555;margin-top:8px}
  .qa-item{display:flex;align-items:flex-start;gap:10px;padding:10px;border:1px solid #e5e5e5;border-radius:8px;margin-bottom:8px}
  .qa-text{flex:1}.qa-q{font-weight:500;font-size:13px}.qa-a{font-size:12px;color:#666;margin-top:2px}
  .log-item{padding:12px;border-bottom:1px solid #f0f0f0}
  .log-item:last-child{border-bottom:none}
  .log-meta{display:flex;align-items:center;gap:8px;margin-bottom:4px}
  .log-time{font-size:11px;color:#999}
  .log-q{font-size:13px;font-weight:500;margin-bottom:4px}
  .log-a{font-size:12px;color:#666;line-height:1.5}
  .badge{display:inline-flex;align-items:center;font-size:11px;font-weight:500;padding:2px 8px;border-radius:20px}
  .badge-escalated{background:#fef3c7;color:#92400e}
  .badge-answered{background:#d1fae5;color:#065f46}
  .form-row{display:flex;gap:10px}.form-row>*{flex:1}
  .saved-msg{font-size:12px;color:#059669;margin-left:10px;opacity:0;transition:opacity .3s}
</style>
</head>
<body>
<div class="sidebar">
  <div class="logo"><div class="logo-dot"></div>HR Bot Admin</div>
  <div class="nav active" onclick="showPage('dashboard',this)">📊 Dashboard</div>
  <div class="nav" onclick="showPage('tone',this)">🎚 Tone & style</div>
  <div class="nav" onclick="showPage('knowledge',this)">📚 Custom Q&As</div>
  <div class="nav" onclick="showPage('log',this)">💬 Question log</div>
</div>

<div class="main">

  <!-- Dashboard -->
  <div class="page active" id="page-dashboard">
    <h1>Dashboard</h1>
    <div class="sub">Overview of your HR bot activity.</div>
    <div class="stats">
      <div class="stat"><div class="stat-label">Total questions</div><div class="stat-val" id="stat-total">0</div></div>
      <div class="stat"><div class="stat-label">Escalations</div><div class="stat-val" id="stat-escalations">0</div></div>
      <div class="stat"><div class="stat-label">Answer rate</div><div class="stat-val" id="stat-rate">0%</div></div>
    </div>
    <div class="card">
      <div class="card-title">📋 Recent questions</div>
      <div id="recent-log">Loading...</div>
    </div>
  </div>

  <!-- Tone -->
  <div class="page" id="page-tone">
    <h1>Tone & style</h1>
    <div class="sub">Adjust how the HR bot communicates with employees.</div>
    <div class="card">
      <div class="card-title">🎚 Communication style</div>
      <div class="tone-row">
        <div class="tone-label">Formality</div>
        <div style="flex:1">
          <input type="range" min="0" max="100" value="60" id="sl-formality" oninput="updatePreview()">
          <div class="tone-ends"><span>Casual</span><span>Formal</span></div>
        </div>
      </div>
      <div class="tone-row">
        <div class="tone-label">Detail level</div>
        <div style="flex:1">
          <input type="range" min="0" max="100" value="50" id="sl-detail" oninput="updatePreview()">
          <div class="tone-ends"><span>Concise</span><span>Thorough</span></div>
        </div>
      </div>
      <div class="tone-row">
        <div class="tone-label">Emoji use</div>
        <div style="flex:1">
          <input type="range" min="0" max="100" value="20" id="sl-emoji" oninput="updatePreview()">
          <div class="tone-ends"><span>None</span><span>Frequent</span></div>
        </div>
      </div>
      <div style="margin-top:4px">
        <label>Tone description (used in bot prompt)</label>
        <input type="text" id="tone-text" value="warm and friendly">
      </div>
      <div style="margin-top:12px">
        <div style="font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:.05em;color:#999;margin-bottom:6px">Preview</div>
        <div class="preview-box" id="tone-preview">Hi there! Happy to help with your parental leave question. You're entitled to 16 weeks of paid leave. Would you like me to walk you through the full details?</div>
      </div>
      <div style="margin-top:14px;display:flex;align-items:center">
        <button class="btn btn-primary" onclick="saveTone()">Save tone settings</button>
        <span class="saved-msg" id="tone-saved">Saved!</span>
      </div>
    </div>
  </div>

  <!-- Knowledge -->
  <div class="page" id="page-knowledge">
    <h1>Custom Q&As</h1>
    <div class="sub">Add specific answers the bot should always use for common questions.</div>
    <div class="card">
      <div class="card-title">➕ Add new Q&A</div>
      <div class="form-row" style="margin-bottom:10px">
        <div><label>Question</label><input type="text" id="new-q" placeholder="e.g. What are office hours?"></div>
        <div><label>Answer</label><input type="text" id="new-a" placeholder="e.g. Monday to Friday, 9am–6pm"></div>
      </div>
      <button class="btn btn-primary" onclick="addQA()">Add Q&A</button>
    </div>
    <div class="card">
      <div class="card-title">📋 Saved Q&As</div>
      <div id="qa-list">Loading...</div>
    </div>
  </div>

  <!-- Log -->
  <div class="page" id="page-log">
    <h1>Question log</h1>
    <div class="sub">All questions employees have asked the HR bot.</div>
    <div class="card" style="padding:0;overflow:hidden">
      <div id="full-log" style="max-height:600px;overflow-y:auto">Loading...</div>
    </div>
  </div>

</div>

<script>
let data = { config: {}, questionLog: [], escalationLog: [] };

async function load() {
  const r = await fetch('/admin/data');
  data = await r.json();
  renderAll();
}

function renderAll() {
  // Stats
  const total = data.questionLog.length;
  const esc = data.escalationLog.length;
  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-escalations').textContent = esc;
  document.getElementById('stat-rate').textContent = total ? Math.round((total - esc) / total * 100) + '%' : '0%';

  // Recent log (dashboard)
  const recent = data.questionLog.slice(0, 5);
  document.getElementById('recent-log').innerHTML = recent.length ? recent.map(renderLogItem).join('') : '<div style="color:#999;font-size:13px;padding:8px 0">No questions yet.</div>';

  // Full log
  document.getElementById('full-log').innerHTML = data.questionLog.length ? data.questionLog.map(renderLogItem).join('') : '<div style="color:#999;font-size:13px;padding:16px">No questions yet.</div>';

  // Q&As
  document.getElementById('qa-list').innerHTML = data.config.customQAs?.length ? data.config.customQAs.map((qa, i) => \`
    <div class="qa-item">
      <div class="qa-text"><div class="qa-q">\${qa.q}</div><div class="qa-a">\${qa.a}</div></div>
      <button class="btn btn-danger" onclick="deleteQA(\${i})" style="padding:4px 10px;font-size:12px">✕</button>
    </div>\`).join('') : '<div style="color:#999;font-size:13px">No custom Q&As yet.</div>';

  // Tone sliders
  if (data.config.formality !== undefined) document.getElementById('sl-formality').value = data.config.formality;
  if (data.config.detail !== undefined) document.getElementById('sl-detail').value = data.config.detail;
  if (data.config.emoji !== undefined) document.getElementById('sl-emoji').value = data.config.emoji;
  if (data.config.tone) document.getElementById('tone-text').value = data.config.tone;
}

function renderLogItem(item) {
  const time = new Date(item.time).toLocaleString('en-GB', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
  const badge = item.escalated ? '<span class="badge badge-escalated">Escalated</span>' : '<span class="badge badge-answered">Answered</span>';
  return \`<div class="log-item">
    <div class="log-meta"><span class="log-time">\${time}</span>\${badge}</div>
    <div class="log-q">Q: \${item.question}</div>
    <div class="log-a">A: \${item.answer?.slice(0, 200)}\${item.answer?.length > 200 ? '...' : ''}</div>
  </div>\`;
}

function showPage(id, el) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav').forEach(n => n.classList.remove('active'));
  document.getElementById('page-' + id).classList.add('active');
  el.classList.add('active');
}

const previews = [
  "Hey! Quick answer — you get 16 weeks parental leave. Want more details? 😊",
  "Hi there! Happy to help. You're entitled to 16 weeks of paid parental leave.",
  "Regarding parental leave: full-time employees are entitled to 16 weeks of paid leave.",
  "In accordance with our Parental Leave Policy, full-time employees are entitled to 16 weeks of fully paid parental leave."
];
function updatePreview() {
  const f = parseInt(document.getElementById('sl-formality').value);
  const idx = f < 25 ? 0 : f < 50 ? 1 : f < 75 ? 2 : 3;
  document.getElementById('tone-preview').textContent = previews[idx];
}

async function saveTone() {
  await fetch('/admin/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tone: document.getElementById('tone-text').value,
      formality: document.getElementById('sl-formality').value,
      detail: document.getElementById('sl-detail').value,
      emoji: document.getElementById('sl-emoji').value
    })
  });
  const msg = document.getElementById('tone-saved');
  msg.style.opacity = 1;
  setTimeout(() => msg.style.opacity = 0, 2000);
}

async function addQA() {
  const q = document.getElementById('new-q').value.trim();
  const a = document.getElementById('new-a').value.trim();
  if (!q || !a) return alert('Please fill in both fields');
  await fetch('/admin/qa/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q, a }) });
  document.getElementById('new-q').value = '';
  document.getElementById('new-a').value = '';
  await load();
}

async function deleteQA(index) {
  if (!confirm('Delete this Q&A?')) return;
  await fetch('/admin/qa/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index }) });
  await load();
}

load();
setInterval(load, 30000);
</script>
</body>
</html>`);
});

// ─── Health check ─────────────────────────────────────────────────
app.get('/', (req, res) => res.send('HR bot is running!'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`HR bot listening on port ${PORT}`));
