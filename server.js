const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const QRCode = require('qrcode');
const Jimp = require('jimp');
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
  voters: [], segments: [],
  settings: { eventName: 'Campaign Event 2026', checkinUrl: '', ezUser: '' },
  campaignImage: null // base64 stored here
};
try { if (fs.existsSync(DB_PATH)) DB = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch(e) {}
function saveDB() { try { fs.writeFileSync(DB_PATH, JSON.stringify(DB)); } catch(e) {} }
function uid() { return (Date.now().toString(36) + Math.random().toString(36).substr(2, 4)).toUpperCase(); }
function nextNum() {
  if (!DB.voters.length) return 1;
  return Math.max(...DB.voters.map(v => v.number || 0)) + 1;
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'VoterQR running', voters: DB.voters.length }));

// ── QR Generation ─────────────────────────────────────────────────────────────
async function generateQR(voter, host) {
  const baseUrl = DB.settings.checkinUrl || `https://${host}`;
  const checkinUrl = `${baseUrl}/checkin?voter=${voter.id}`;
  const filePath = path.join(QR_DIR, `${voter.id}.png`);
  const num = voter.number || '?';
  const name = `${voter.firstName} ${voter.lastName}`.trim();

  if (DB.campaignImage) {
    // Embed QR into campaign image
    const qrBuf = await QRCode.toBuffer(checkinUrl, { width: 220, margin: 1 });
    const [campaign, qrImg] = await Promise.all([
      Jimp.read(Buffer.from(DB.campaignImage, 'base64')),
      Jimp.read(qrBuf)
    ]);

    // White padding around QR
    const pad = 16;
    const badge = new Jimp(qrImg.bitmap.width + pad*2, qrImg.bitmap.height + pad*2 + 48, 0xFFFFFFFF);
    badge.composite(qrImg, pad, pad);

    // Add number + name text
    const font = await Jimp.loadFont(Jimp.FONT_SANS_16_BLACK);
    const label = `#${num} ${name}`;
    badge.print(font, 0, qrImg.bitmap.height + pad + 6, { text: label, alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER }, badge.bitmap.width, 40);

    // Place badge bottom-right with 20px margin
    const bx = campaign.bitmap.width - badge.bitmap.width - 20;
    const by = campaign.bitmap.height - badge.bitmap.height - 20;
    campaign.composite(badge, bx, by);
    await campaign.writeAsync(filePath);
  } else {
    // Plain QR with number label
    const qrBuf = await QRCode.toBuffer(checkinUrl, { width: 340, margin: 2 });
    const qrImg = await Jimp.read(qrBuf);
    const cardW = 340, cardH = 420;
    const card = new Jimp(cardW, cardH, 0xFFFFFFFF);
    card.composite(qrImg, 0, 0);

    const font32 = await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK);
    const font16 = await Jimp.loadFont(Jimp.FONT_SANS_16_BLACK);
    card.print(font32, 0, 348, { text: `#${num}`, alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER }, cardW, 40);
    card.print(font16, 8, 392, { text: name, alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER }, cardW - 16, 24);
    await card.writeAsync(filePath);
  }

  return `/qrcodes/${voter.id}.png`;
}

// ── Voters ────────────────────────────────────────────────────────────────────
app.get('/api/voters', (req, res) => res.json(DB.voters));

app.post('/api/voters', (req, res) => {
  const v = {
    id: uid(), number: nextNum(),
    firstName: '', lastName: '', phone: '', address: '', segments: [],
    checkedIn: false, checkInTime: null,
    followUp: { status: 'pending', notes: '', lastContactDate: null },
    ...req.body
  };
  DB.voters.push(v); saveDB(); res.json(v);
});

app.post('/api/voters/import', (req, res) => {
  const list = req.body.voters || [], segId = req.body.segmentId || null;
  let num = nextNum();
  list.forEach(v => DB.voters.push({
    id: uid(), number: num++,
    firstName: v.firstName||'', lastName: v.lastName||'',
    phone: v.phone||'', address: v.address||'',
    segments: segId ? [segId] : [],
    checkedIn: false, checkInTime: null,
    followUp: { status: 'pending', notes: '', lastContactDate: null }
  }));
  saveDB(); res.json({ added: list.length, total: DB.voters.length });
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

// Check in by voter ID or by number
app.post('/api/voters/:id/checkin', (req, res) => {
  let v = DB.voters.find(v => v.id === req.params.id);
  // If not found by ID, try by number
  if (!v) {
    const num = parseInt(req.params.id);
    if (!isNaN(num)) v = DB.voters.find(v => v.number === num);
  }
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

// Create segment from no-shows (checked in = false)
app.post('/api/segments/noshows', (req, res) => {
  const name = req.body.name || 'No Shows ' + new Date().toLocaleDateString();
  const seg = { id: uid(), name, color: '#dc2626' };
  DB.segments.push(seg);
  const noShows = DB.voters.filter(v => !v.checkedIn);
  noShows.forEach(v => { v.segments = [...new Set([...(v.segments||[]), seg.id])]; });
  saveDB();
  res.json({ segment: seg, added: noShows.length });
});

// ── Settings & Campaign Image ─────────────────────────────────────────────────
app.get('/api/settings', (req, res) => res.json(DB.settings));
app.put('/api/settings', (req, res) => {
  DB.settings = { ...DB.settings, ...req.body }; saveDB(); res.json(DB.settings);
});

// Upload campaign image (base64 PNG/JPG)
app.post('/api/campaign-image', (req, res) => {
  const { imageBase64 } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'No image provided' });
  DB.campaignImage = imageBase64;
  saveDB();
  res.json({ ok: true });
});

app.delete('/api/campaign-image', (req, res) => {
  DB.campaignImage = null; saveDB(); res.json({ ok: true });
});

app.get('/api/campaign-image', (req, res) => {
  res.json({ hasImage: !!DB.campaignImage, preview: DB.campaignImage ? DB.campaignImage.substring(0, 100) : null });
});

// ── EZTexting ─────────────────────────────────────────────────────────────────
function ezBasicAuth(u, p) {
  return 'Basic ' + Buffer.from(u + ':' + p).toString('base64');
}

app.post('/send-mms', async (req, res) => {
  const { username, password, phone, message, voterId } = req.body;
  if (!username || !password || !phone || !message || !voterId)
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  try {
    const voter = DB.voters.find(v => v.id === voterId);
    if (!voter) return res.status(404).json({ success: false, error: 'Voter not found' });

    const cleanPhone = phone.replace(/\D/g, '').replace(/^1/, '');
    const host = req.headers.host;
    const qrPath = await generateQR(voter, host);
    const serverBase = DB.settings.checkinUrl || `https://${host}`;
    const mediaUrl = `${serverBase}${qrPath}`;

    console.log('MMS to', cleanPhone, '| mediaUrl:', mediaUrl);

    const sendRes = await fetch('https://a.eztexting.com/v1/messages', {
      method: 'POST',
      headers: {
        'Authorization': ezBasicAuth(username, password),
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ toNumbers: [cleanPhone], message, mediaUrl })
    });

    const data = await sendRes.json().catch(() => ({}));
    console.log('EZTexting:', sendRes.status, JSON.stringify(data));
    if (!sendRes.ok) return res.status(400).json({ success: false, error: JSON.stringify(data) });
    return res.json({ success: true });
  } catch(err) {
    console.error('send-mms error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/send-sms', async (req, res) => {
  const { username, password, phone, message } = req.body;
  if (!username || !password || !phone || !message)
    return res.status(400).json({ success: false, error: 'Missing fields' });
  try {
    const cleanPhone = phone.replace(/\D/g, '').replace(/^1/, '');
    const sendRes = await fetch('https://a.eztexting.com/v1/messages', {
      method: 'POST',
      headers: {
        'Authorization': ezBasicAuth(username, password),
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ toNumbers: [cleanPhone], message })
    });
    const data = await sendRes.json().catch(() => ({}));
    if (!sendRes.ok) return res.status(400).json({ success: false, error: JSON.stringify(data) });
    return res.json({ success: true });
  } catch(err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── SPA ───────────────────────────────────────────────────────────────────────
app.get('/checkin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'checkin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`VoterQR running on port ${PORT}`));
