const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const QRCode = require('qrcode');
const Jimp = require('jimp');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const QR_DIR = path.join(__dirname, 'public', 'qrcodes');
if (!fs.existsSync(QR_DIR)) fs.mkdirSync(QR_DIR, { recursive: true });

// ── DB ────────────────────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'data.json');
let DB = {
  voters: [], segments: [], campaigns: [],
  settings: { eventName: 'Campaign Event 2026', checkinUrl: '', ezUser: '' },
  campaignImage: null
};
function loadDB() {
  try { if (fs.existsSync(DB_PATH)) DB = { ...DB, ...JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) }; } catch(e) {}
}
function saveDB() { try { fs.writeFileSync(DB_PATH, JSON.stringify(DB)); } catch(e) {} }
function uid() { return (Date.now().toString(36) + Math.random().toString(36).substr(2, 4)).toUpperCase(); }
function nextNum() { return DB.voters.length ? Math.max(...DB.voters.map(v => v.number || 0)) + 1 : 1; }
loadDB();

// Active sending jobs (in-memory, keyed by campaign id)
const JOBS = {};

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'VoterQR running', voters: DB.voters.length, campaigns: DB.campaigns.length }));

// ── QR Generation ─────────────────────────────────────────────────────────────
async function generateQR(voter, host) {
  const baseUrl = DB.settings.checkinUrl || `https://${host}`;
  const checkinUrl = `${baseUrl}/checkin?voter=${voter.id}`;
  const filePath = path.join(QR_DIR, `${voter.id}.png`);
  const num = voter.number || '?';
  const name = `${voter.firstName} ${voter.lastName}`.trim();

  if (DB.campaignImage) {
    const qrBuf = await QRCode.toBuffer(checkinUrl, { width: 220, margin: 1 });
    const [campaign, qrImg] = await Promise.all([
      Jimp.read(Buffer.from(DB.campaignImage, 'base64')),
      Jimp.read(qrBuf)
    ]);
    const pad = 16;
    const badge = new Jimp(qrImg.bitmap.width + pad * 2, qrImg.bitmap.height + pad * 2 + 48, 0xFFFFFFFF);
    badge.composite(qrImg, pad, pad);
    const font = await Jimp.loadFont(Jimp.FONT_SANS_16_BLACK);
    badge.print(font, 0, qrImg.bitmap.height + pad + 6, { text: `#${num} ${name}`, alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER }, badge.bitmap.width, 40);
    const bx = campaign.bitmap.width - badge.bitmap.width - 20;
    const by = campaign.bitmap.height - badge.bitmap.height - 20;
    campaign.composite(badge, bx, by);
    await campaign.writeAsync(filePath);
  } else {
    const qrBuf = await QRCode.toBuffer(checkinUrl, { width: 340, margin: 2 });
    const qrImg = await Jimp.read(qrBuf);
    const card = new Jimp(340, 420, 0xFFFFFFFF);
    card.composite(qrImg, 0, 0);
    const font32 = await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK);
    const font16 = await Jimp.loadFont(Jimp.FONT_SANS_16_BLACK);
    card.print(font32, 0, 348, { text: `#${num}`, alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER }, 340, 40);
    card.print(font16, 8, 392, { text: name, alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER }, 324, 24);
    await card.writeAsync(filePath);
  }
  return `/qrcodes/${voter.id}.png`;
}

// ── Server-side campaign sending ──────────────────────────────────────────────
function ezBasicAuth(u, p) { return 'Basic ' + Buffer.from(u + ':' + p).toString('base64'); }

async function sendOneMMS(voter, campaign, host) {
  const cleanPhone = voter.phone.replace(/\D/g, '').replace(/^1/, '');
  const qrPath = await generateQR(voter, host);
  const serverBase = DB.settings.checkinUrl || `https://${host}`;
  const mediaUrl = `${serverBase}${qrPath}`;
  const message = campaign.message
    .replace(/{first_name}/g, voter.firstName)
    .replace(/{last_name}/g, voter.lastName)
    .replace(/{event_name}/g, DB.settings.eventName)
    .replace(/{number}/g, '#' + (voter.number || '?'));

  const res = await fetch('https://a.eztexting.com/v1/messages', {
    method: 'POST',
    headers: { 'Authorization': ezBasicAuth(campaign.ezUser, campaign.ezPass), 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ toNumbers: [cleanPhone], message, mediaUrl })
  });
  const data = await res.json().catch(() => ({}));
  return { success: res.ok, error: res.ok ? null : JSON.stringify(data) };
}

async function sendOneSMS(voter, campaign) {
  const cleanPhone = voter.phone.replace(/\D/g, '').replace(/^1/, '');
  const message = campaign.message
    .replace(/{first_name}/g, voter.firstName)
    .replace(/{last_name}/g, voter.lastName)
    .replace(/{event_name}/g, DB.settings.eventName)
    .replace(/{number}/g, '#' + (voter.number || '?'));

  const res = await fetch('https://a.eztexting.com/v1/messages', {
    method: 'POST',
    headers: { 'Authorization': ezBasicAuth(campaign.ezUser, campaign.ezPass), 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ toNumbers: [cleanPhone], message })
  });
  const data = await res.json().catch(() => ({}));
  return { success: res.ok, error: res.ok ? null : JSON.stringify(data) };
}

async function runCampaign(campaignId, host) {
  const camp = DB.campaigns.find(c => c.id === campaignId);
  if (!camp) return;

  camp.status = 'running';
  camp.startedAt = new Date().toISOString();
  saveDB();

  // Get target voters (by segment or all), skip already sent
  let targets = camp.segmentId
    ? DB.voters.filter(v => (v.segments || []).includes(camp.segmentId))
    : DB.voters;

  // Only send to voters NOT already successfully sent in this campaign
  targets = targets.filter(v => {
    const log = (camp.results || []).find(r => r.voterId === v.id);
    return !log || !log.success; // resend if not sent or failed
  });

  camp.total = (camp.results || []).filter(r => r.success).length + targets.length;
  JOBS[campaignId] = { running: true };

  for (let i = 0; i < targets.length; i++) {
    if (!JOBS[campaignId] || !JOBS[campaignId].running) {
      camp.status = 'paused';
      saveDB();
      return;
    }

    const voter = targets[i];
    let result;
    try {
      result = camp.mode === 'mms'
        ? await sendOneMMS(voter, camp, host)
        : await sendOneSMS(voter, camp);
    } catch(e) {
      result = { success: false, error: e.message };
    }

    // Remove old result for this voter if exists, then add new one
    camp.results = (camp.results || []).filter(r => r.voterId !== voter.id);
    camp.results.push({
      voterId: voter.id,
      name: `${voter.firstName} ${voter.lastName}`,
      phone: voter.phone,
      success: result.success,
      error: result.error,
      sentAt: new Date().toISOString()
    });

    // Mark voter as sent for this campaign
    if (result.success) {
      voter.sentCampaigns = voter.sentCampaigns || [];
      if (!voter.sentCampaigns.includes(campaignId)) voter.sentCampaigns.push(campaignId);
    }

    camp.sentCount = (camp.results || []).filter(r => r.success).length;
    saveDB();

    // Rate limit: 350ms between sends
    await new Promise(r => setTimeout(r, 350));
  }

  camp.status = 'completed';
  camp.completedAt = new Date().toISOString();
  delete JOBS[campaignId];
  saveDB();
}

// ── Campaign API ──────────────────────────────────────────────────────────────
app.get('/api/campaigns', (req, res) => {
  // Return campaigns without ezPass for security
  const safe = (DB.campaigns || []).map(c => ({ ...c, ezPass: undefined }));
  res.json(safe);
});

app.post('/api/campaigns', (req, res) => {
  const { name, segmentId, message, mode, ezUser, ezPass } = req.body;
  if (!name || !message || !ezUser || !ezPass)
    return res.status(400).json({ error: 'Missing required fields' });

  const camp = {
    id: uid(), name, segmentId: segmentId || null, message,
    mode: mode || 'mms', ezUser, ezPass,
    status: 'ready', results: [], sentCount: 0, total: 0,
    createdAt: new Date().toISOString()
  };

  // Calculate total targets
  camp.total = segmentId
    ? DB.voters.filter(v => (v.segments || []).includes(segmentId)).length
    : DB.voters.length;

  DB.campaigns.push(camp);
  saveDB();
  res.json({ ...camp, ezPass: undefined });
});

app.delete('/api/campaigns/:id', (req, res) => {
  DB.campaigns = (DB.campaigns || []).filter(c => c.id !== req.params.id);
  delete JOBS[req.params.id];
  saveDB();
  res.json({ ok: true });
});

// Start / resume a campaign
app.post('/api/campaigns/:id/start', (req, res) => {
  const camp = DB.campaigns.find(c => c.id === req.params.id);
  if (!camp) return res.status(404).json({ error: 'Campaign not found' });
  if (JOBS[camp.id] && JOBS[camp.id].running)
    return res.status(400).json({ error: 'Already running' });

  // If password provided in body (for resume), update it
  if (req.body.ezPass) camp.ezPass = req.body.ezPass;
  if (!camp.ezPass) return res.status(400).json({ error: 'Password required to start' });

  const host = req.headers.host;
  runCampaign(camp.id, host); // runs async, doesn't block
  res.json({ ok: true, message: 'Campaign started on server' });
});

// Pause a running campaign
app.post('/api/campaigns/:id/pause', (req, res) => {
  if (JOBS[req.params.id]) JOBS[req.params.id].running = false;
  const camp = DB.campaigns.find(c => c.id === req.params.id);
  if (camp) { camp.status = 'paused'; saveDB(); }
  res.json({ ok: true });
});

// Get live status / progress
app.get('/api/campaigns/:id/status', (req, res) => {
  const camp = DB.campaigns.find(c => c.id === req.params.id);
  if (!camp) return res.status(404).json({ error: 'Not found' });
  res.json({
    id: camp.id, name: camp.name, status: camp.status,
    sentCount: camp.sentCount || 0, total: camp.total || 0,
    results: camp.results || [],
    createdAt: camp.createdAt, startedAt: camp.startedAt, completedAt: camp.completedAt
  });
});

// Retry only failed sends in a campaign
app.post('/api/campaigns/:id/retry-failed', (req, res) => {
  const camp = DB.campaigns.find(c => c.id === req.params.id);
  if (!camp) return res.status(404).json({ error: 'Not found' });
  if (req.body.ezPass) camp.ezPass = req.body.ezPass;

  // Remove failed results so they get retried
  camp.results = (camp.results || []).filter(r => r.success);
  camp.status = 'ready';
  saveDB();

  const host = req.headers.host;
  runCampaign(camp.id, host);
  res.json({ ok: true });
});

// ── Voters ────────────────────────────────────────────────────────────────────
app.get('/api/voters', (req, res) => res.json(DB.voters));

app.post('/api/voters', (req, res) => {
  const v = {
    id: uid(), number: nextNum(),
    firstName: '', lastName: '', phone: '', address: '',
    segments: [], checkedIn: false, checkInTime: null,
    sentCampaigns: [],
    followUp: { status: 'pending', notes: '', lastContactDate: null },
    ...req.body
  };
  DB.voters.push(v); saveDB(); res.json(v);
});

app.post('/api/voters/import', (req, res) => {
  const list = req.body.voters || [], segId = req.body.segmentId || null;
  let num = nextNum();
  const added = [];
  list.forEach(v => {
    // Skip duplicates by phone
    const exists = DB.voters.find(x => x.phone.replace(/\D/g,'') === v.phone.replace(/\D/g,''));
    if (exists) {
      if (segId && !(exists.segments||[]).includes(segId)) exists.segments.push(segId);
      return;
    }
    const voter = {
      id: uid(), number: num++,
      firstName: v.firstName||'', lastName: v.lastName||'',
      phone: v.phone||'', address: v.address||'',
      segments: segId ? [segId] : [], checkedIn: false, checkInTime: null,
      sentCampaigns: [],
      followUp: { status: 'pending', notes: '', lastContactDate: null }
    };
    DB.voters.push(voter);
    added.push(voter);
  });
  saveDB();
  res.json({ added: added.length, skipped: list.length - added.length, total: DB.voters.length });
});

// Bulk import from CSV text (sent as plain text body)
app.post('/api/voters/import-csv', express.text({ limit: '5mb' }), (req, res) => {
  const lines = req.body.trim().split('\n').filter(l => l.trim());
  const segId = req.query.segmentId || null;
  const parsed = [];
  lines.forEach(line => {
    if (line.toLowerCase().includes('phone') || line.toLowerCase().includes('first')) return; // skip header
    const p = line.split(',').map(x => x.trim().replace(/^"|"$/g, ''));
    if (p.length >= 2) {
      parsed.push({ firstName: p[0]||'', lastName: p[1]||'', phone: p[2]||p[1]||'' });
    }
  });
  let num = nextNum(), added = 0, skipped = 0;
  parsed.forEach(v => {
    if (!v.phone || v.phone.replace(/\D/g,'').length < 10) { skipped++; return; }
    const exists = DB.voters.find(x => x.phone.replace(/\D/g,'') === v.phone.replace(/\D/g,''));
    if (exists) { skipped++; if (segId && !(exists.segments||[]).includes(segId)) exists.segments.push(segId); return; }
    DB.voters.push({ id: uid(), number: num++, firstName: v.firstName, lastName: v.lastName, phone: v.phone, address: '', segments: segId ? [segId] : [], checkedIn: false, checkInTime: null, sentCampaigns: [], followUp: { status: 'pending', notes: '', lastContactDate: null } });
    added++;
  });
  saveDB();
  res.json({ added, skipped, total: DB.voters.length });
});

app.delete('/api/voters/all', (req, res) => { DB.voters = []; saveDB(); res.json({ ok: true }); });
app.delete('/api/voters/:id', (req, res) => {
  DB.voters = DB.voters.filter(v => v.id !== req.params.id); saveDB(); res.json({ ok: true });
});
app.put('/api/voters/:id', (req, res) => {
  const v = DB.voters.find(v => v.id === req.params.id);
  if (!v) return res.status(404).json({ error: 'Not found' });
  Object.assign(v, req.body); saveDB(); res.json(v);
});
app.post('/api/voters/:id/checkin', (req, res) => {
  let v = DB.voters.find(v => v.id === req.params.id);
  if (!v) { const n = parseInt(req.params.id); if (!isNaN(n)) v = DB.voters.find(v => v.number === n); }
  if (!v) return res.status(404).json({ error: 'Voter not found' });
  const already = v.checkedIn;
  if (!already) { v.checkedIn = true; v.checkInTime = new Date().toISOString(); saveDB(); }
  res.json({ voter: v, alreadyCheckedIn: already });
});
app.put('/api/voters/:id/followup', (req, res) => {
  const v = DB.voters.find(v => v.id === req.params.id);
  if (!v) return res.status(404).json({ error: 'Not found' });
  v.followUp = { ...v.followUp, ...req.body, lastContactDate: new Date().toISOString() };
  saveDB(); res.json(v);
});

// ── Segments ──────────────────────────────────────────────────────────────────
app.get('/api/segments', (req, res) => res.json(DB.segments));
app.post('/api/segments', (req, res) => {
  const s = { id: uid(), name: '', color: '#2563eb', ...req.body };
  DB.segments.push(s); saveDB(); res.json(s);
});
app.delete('/api/segments/:id', (req, res) => {
  DB.segments = DB.segments.filter(s => s.id !== req.params.id);
  DB.voters.forEach(v => { v.segments = (v.segments||[]).filter(s => s !== req.params.id); });
  saveDB(); res.json({ ok: true });
});
app.post('/api/segments/noshows', (req, res) => {
  const name = req.body.name || 'No Shows ' + new Date().toLocaleDateString();
  const seg = { id: uid(), name, color: '#dc2626' };
  DB.segments.push(seg);
  let count = 0;
  DB.voters.filter(v => !v.checkedIn).forEach(v => {
    v.segments = [...new Set([...(v.segments||[]), seg.id])]; count++;
  });
  saveDB(); res.json({ segment: seg, added: count });
});

// ── Settings & Campaign Image ─────────────────────────────────────────────────
app.get('/api/settings', (req, res) => res.json(DB.settings));
app.put('/api/settings', (req, res) => { DB.settings = { ...DB.settings, ...req.body }; saveDB(); res.json(DB.settings); });
app.post('/api/campaign-image', (req, res) => {
  if (!req.body.imageBase64) return res.status(400).json({ error: 'No image' });
  DB.campaignImage = req.body.imageBase64; saveDB(); res.json({ ok: true });
});
app.delete('/api/campaign-image', (req, res) => { DB.campaignImage = null; saveDB(); res.json({ ok: true }); });
app.get('/api/campaign-image', (req, res) => res.json({ hasImage: !!DB.campaignImage }));

// ── SPA ───────────────────────────────────────────────────────────────────────
app.get('/checkin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'checkin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`VoterQR running on port ${PORT}`));
