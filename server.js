const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const QRCode = require('qrcode');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

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

const JOBS = {};

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'VoterQR running', voters: DB.voters.length }));

// ── QR Generation with sharp (fast native C++) ────────────────────────────────
// Returns cached file path if already generated
async function generateQR(voter, host) {
  const filePath = path.join(QR_DIR, `${voter.id}.png`);
  if (fs.existsSync(filePath)) return `/qrcodes/${voter.id}.png`;

  const baseUrl = DB.settings.checkinUrl || `https://${host}`;
  const checkinUrl = `${baseUrl}/checkin?voter=${voter.id}`;
  const num = voter.number || '?';
  const name = `${voter.firstName} ${voter.lastName}`.trim().substring(0, 26);

  const QR_SIZE = 360;
  const qrBuf = await QRCode.toBuffer(checkinUrl, { type: 'png', width: QR_SIZE, margin: 2 });

  // QR panel: QR image + number/name label below, white background
  const labelSvg = Buffer.from(`<svg width="${QR_SIZE}" height="72">
    <rect width="${QR_SIZE}" height="72" fill="white"/>
    <text x="${QR_SIZE/2}" y="30" font-family="Arial" font-size="24" font-weight="bold" text-anchor="middle" fill="#2563eb">#${num}</text>
    <text x="${QR_SIZE/2}" y="56" font-family="Arial" font-size="14" text-anchor="middle" fill="#444">${name}</text>
  </svg>`);

  const qrPanel = await sharp(qrBuf)
    .extend({ bottom: 72, background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .composite([{ input: labelSvg, top: QR_SIZE, left: 0 }])
    .png().toBuffer();

  if (DB.campaignImage) {
    // Side-by-side: campaign image LEFT, QR panel RIGHT
    // Both scaled to same height — nothing gets covered
    const campBuf = Buffer.from(DB.campaignImage, 'base64');
    const campMeta = await sharp(campBuf).metadata();

    const targetH = Math.max(campMeta.height, QR_SIZE + 72);
    // Scale campaign image to target height
    const campResized = await sharp(campBuf)
      .resize({ height: targetH, fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .png().toBuffer();
    const campResizedMeta = await sharp(campResized).metadata();

    // Scale QR panel to target height
    const qrResized = await sharp(qrPanel)
      .resize({ height: targetH, fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .png().toBuffer();
    const qrResizedMeta = await sharp(qrResized).metadata();

    const totalW = campResizedMeta.width + qrResizedMeta.width;

    // Create white canvas and place both side by side
    await sharp({
      create: { width: totalW, height: targetH, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } }
    })
    .composite([
      { input: campResized, left: 0, top: 0 },
      { input: qrResized, left: campResizedMeta.width, top: 0 }
    ])
    .png().toFile(filePath);
  } else {
    // Plain QR panel only
    await sharp(qrPanel).png().toFile(filePath);
  }

  return `/qrcodes/${voter.id}.png`;
}

// Clear QR cache (call when campaign image changes)
function clearQRCache() {
  try {
    fs.readdirSync(QR_DIR).forEach(f => {
      if (f.endsWith('.png')) fs.unlinkSync(path.join(QR_DIR, f));
    });
  } catch(e) {}
}

// Pre-generate QRs for all voters in a segment (background, non-blocking)
async function pregenerateQRs(segmentId, host) {
  const targets = segmentId
    ? DB.voters.filter(v => (v.segments||[]).includes(segmentId))
    : DB.voters;
  for (const voter of targets) {
    try { await generateQR(voter, host); } catch(e) { console.error('QR gen error', voter.id, e.message); }
  }
}

// ── EZTexting ─────────────────────────────────────────────────────────────────
function ezAuth(u, p) { return 'Basic ' + Buffer.from(u + ':' + p).toString('base64'); }

async function sendOneMMS(voter, campaign, host) {
  const cleanPhone = voter.phone.replace(/\D/g, '').replace(/^1/, '');
  const qrPath = await generateQR(voter, host);
  const base = DB.settings.checkinUrl || `https://${host}`;
  const mediaUrl = `${base}${qrPath}`;
  const message = campaign.message
    .replace(/{first_name}/g, voter.firstName)
    .replace(/{last_name}/g, voter.lastName)
    .replace(/{event_name}/g, DB.settings.eventName)
    .replace(/{number}/g, '#' + (voter.number || '?'));

  const res = await fetch('https://a.eztexting.com/v1/messages', {
    method: 'POST',
    headers: { 'Authorization': ezAuth(campaign.ezUser, campaign.ezPass), 'Content-Type': 'application/json', 'Accept': 'application/json' },
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
    headers: { 'Authorization': ezAuth(campaign.ezUser, campaign.ezPass), 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ toNumbers: [cleanPhone], message })
  });
  const data = await res.json().catch(() => ({}));
  return { success: res.ok, error: res.ok ? null : JSON.stringify(data) };
}

// ── Campaign runner ───────────────────────────────────────────────────────────
async function runCampaign(campaignId, host) {
  const camp = DB.campaigns.find(c => c.id === campaignId);
  if (!camp) return;

  camp.status = 'running';
  camp.startedAt = camp.startedAt || new Date().toISOString();
  camp.statusMessage = '';
  saveDB();

  let targets = camp.segmentId
    ? DB.voters.filter(v => (v.segments||[]).includes(camp.segmentId))
    : DB.voters;

  targets = targets.filter(v => {
    const log = (camp.results||[]).find(r => r.voterId === v.id);
    return !log || !log.success;
  });

  camp.total = (camp.results||[]).filter(r => r.success).length + targets.length;
  JOBS[campaignId] = { running: true };
  saveDB();

  const BATCH = 10; // send 10 at a time in parallel
  for (let i = 0; i < targets.length; i += BATCH) {
    if (!JOBS[campaignId] || !JOBS[campaignId].running) {
      camp.status = 'paused';
      camp.statusMessage = 'Paused at ' + i + ' of ' + targets.length;
      saveDB(); return;
    }

    const batch = targets.slice(i, i + BATCH);
    camp.statusMessage = 'Sending ' + Math.min(i + BATCH, targets.length) + ' of ' + targets.length + '...';

    // Send batch in parallel
    const batchResults = await Promise.all(batch.map(async voter => {
      try {
        const result = camp.mode === 'mms'
          ? await sendOneMMS(voter, camp, host)
          : await sendOneSMS(voter, camp);
        return { voter, ...result };
      } catch(e) {
        return { voter, success: false, error: e.message };
      }
    }));

    // Record results
    for (const r of batchResults) {
      camp.results = (camp.results||[]).filter(x => x.voterId !== r.voter.id);
      camp.results.push({
        voterId: r.voter.id,
        name: r.voter.firstName + ' ' + r.voter.lastName,
        phone: r.voter.phone,
        success: r.success,
        error: r.error||null,
        sentAt: new Date().toISOString()
      });
      if (r.success) {
        r.voter.sentCampaigns = r.voter.sentCampaigns || [];
        if (!r.voter.sentCampaigns.includes(campaignId)) r.voter.sentCampaigns.push(campaignId);
      }
    }

    camp.sentCount = (camp.results||[]).filter(r => r.success).length;
    saveDB();
    // Small pause between batches to avoid rate limiting
    await new Promise(r => setTimeout(r, 500));
  }

  camp.status = 'completed';
  camp.statusMessage = 'Done — ' + camp.sentCount + ' sent';
  camp.completedAt = new Date().toISOString();
  delete JOBS[campaignId];
  saveDB();
}

// ── Campaign API ──────────────────────────────────────────────────────────────
app.get('/api/campaigns', (req, res) => res.json((DB.campaigns||[]).map(c => ({ ...c, ezPass: undefined }))));

app.post('/api/campaigns', (req, res) => {
  const { name, segmentId, message, mode, ezUser, ezPass } = req.body;
  if (!name || !message || !ezUser || !ezPass) return res.status(400).json({ error: 'Missing required fields' });
  const camp = {
    id: uid(), name, segmentId: segmentId || null, message,
    mode: mode || 'mms', ezUser, ezPass,
    status: 'ready', results: [], sentCount: 0,
    total: segmentId ? DB.voters.filter(v => (v.segments||[]).includes(segmentId)).length : DB.voters.length,
    createdAt: new Date().toISOString()
  };
  DB.campaigns.push(camp); saveDB();
  res.json({ ...camp, ezPass: undefined });
});

app.delete('/api/campaigns/:id', (req, res) => {
  DB.campaigns = (DB.campaigns||[]).filter(c => c.id !== req.params.id);
  delete JOBS[req.params.id]; saveDB(); res.json({ ok: true });
});

app.post('/api/campaigns/:id/start', (req, res) => {
  const camp = DB.campaigns.find(c => c.id === req.params.id);
  if (!camp) return res.status(404).json({ error: 'Not found' });
  if (JOBS[camp.id]?.running) return res.json({ ok: true, message: 'Already running' });
  if (req.body.ezPass) camp.ezPass = req.body.ezPass;
  if (!camp.ezPass) return res.status(400).json({ error: 'Password required' });
  const host = req.headers.host;
  runCampaign(camp.id, host);
  res.json({ ok: true });
});

app.post('/api/campaigns/:id/pause', (req, res) => {
  if (JOBS[req.params.id]) JOBS[req.params.id].running = false;
  const camp = DB.campaigns.find(c => c.id === req.params.id);
  if (camp) { camp.status = 'paused'; saveDB(); }
  res.json({ ok: true });
});

app.get('/api/campaigns/:id/status', (req, res) => {
  const camp = DB.campaigns.find(c => c.id === req.params.id);
  if (!camp) return res.status(404).json({ error: 'Not found' });
  res.json({ id: camp.id, name: camp.name, status: camp.status, statusMessage: camp.statusMessage||'', sentCount: camp.sentCount||0, total: camp.total||0, results: (camp.results||[]).slice(-20), createdAt: camp.createdAt, startedAt: camp.startedAt, completedAt: camp.completedAt });
});

app.post('/api/campaigns/:id/retry-failed', (req, res) => {
  const camp = DB.campaigns.find(c => c.id === req.params.id);
  if (!camp) return res.status(404).json({ error: 'Not found' });
  if (req.body.ezPass) camp.ezPass = req.body.ezPass;
  camp.results = (camp.results||[]).filter(r => r.success);
  camp.status = 'ready'; saveDB();
  runCampaign(camp.id, req.headers.host);
  res.json({ ok: true });
});

// ── Voters ────────────────────────────────────────────────────────────────────
app.get('/api/voters', (req, res) => res.json(DB.voters));

app.post('/api/voters', (req, res) => {
  const v = { id: uid(), number: nextNum(), firstName: '', lastName: '', phone: '', address: '', segments: [], checkedIn: false, checkInTime: null, sentCampaigns: [], followUp: { status: 'pending', notes: '', lastContactDate: null }, ...req.body };
  DB.voters.push(v); saveDB(); res.json(v);
});

app.post('/api/voters/import', (req, res) => {
  const list = req.body.voters || [], segId = req.body.segmentId || null;
  let num = nextNum(), added = 0, skipped = 0;
  list.forEach(v => {
    const phone = (v.phone||'').replace(/\D/g,'');
    if (phone.length < 10) { skipped++; return; }
    const exists = DB.voters.find(x => x.phone.replace(/\D/g,'') === phone);
    if (exists) { skipped++; if (segId && !(exists.segments||[]).includes(segId)) exists.segments.push(segId); return; }
    DB.voters.push({ id: uid(), number: num++, firstName: v.firstName||'', lastName: v.lastName||'', phone: v.phone||'', address: v.address||'', segments: segId?[segId]:[], checkedIn: false, checkInTime: null, sentCampaigns: [], followUp: { status: 'pending', notes: '', lastContactDate: null } });
    added++;
  });
  saveDB(); res.json({ added, skipped, total: DB.voters.length });
});

app.delete('/api/voters/all', (req, res) => { DB.voters = []; clearQRCache(); saveDB(); res.json({ ok: true }); });
app.delete('/api/voters/:id', (req, res) => { DB.voters = DB.voters.filter(v => v.id !== req.params.id); saveDB(); res.json({ ok: true }); });

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
app.post('/api/segments', (req, res) => { const s = { id: uid(), name: '', color: '#2563eb', ...req.body }; DB.segments.push(s); saveDB(); res.json(s); });
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
  DB.voters.filter(v => !v.checkedIn).forEach(v => { v.segments = [...new Set([...(v.segments||[]), seg.id])]; count++; });
  saveDB(); res.json({ segment: seg, added: count });
});

// ── Settings & Campaign Image ─────────────────────────────────────────────────
app.get('/api/settings', (req, res) => res.json(DB.settings));
app.put('/api/settings', (req, res) => { DB.settings = { ...DB.settings, ...req.body }; saveDB(); res.json(DB.settings); });

app.post('/api/campaign-image', (req, res) => {
  if (!req.body.imageBase64) return res.status(400).json({ error: 'No image' });
  DB.campaignImage = req.body.imageBase64;
  clearQRCache(); // Force QR regeneration with new image
  saveDB(); res.json({ ok: true });
});
app.delete('/api/campaign-image', (req, res) => { DB.campaignImage = null; clearQRCache(); saveDB(); res.json({ ok: true }); });
app.get('/api/campaign-image', (req, res) => res.json({ hasImage: !!DB.campaignImage }));

// Pre-generate QRs endpoint (call before sending to warm up cache)
app.post('/api/pregenerate-qr', async (req, res) => {
  const { segmentId } = req.body;
  const host = req.headers.host;
  res.json({ ok: true, message: 'Pre-generating QR codes in background...' });
  pregenerateQRs(segmentId, host).catch(e => console.error('Pregen error:', e));
});

// ── SPA ───────────────────────────────────────────────────────────────────────
app.get('/checkin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'checkin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`VoterQR v4.1 running on port ${PORT}`));
