const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Ensure qrcodes folder exists inside public (served as static files)
const QR_DIR = path.join(__dirname, 'public', 'qrcodes');
if (!fs.existsSync(QR_DIR)) fs.mkdirSync(QR_DIR, { recursive: true });

// ── DB ────────────────────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'data.json');
let DB = {
  voters: [], segments: [],
  settings: { eventName: 'Campaign Event 2026', checkinUrl: '', ezUser: '' }
};
try { if (fs.existsSync(DB_PATH)) DB = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch(e) {}
function saveDB() { try { fs.writeFileSync(DB_PATH, JSON.stringify(DB, null, 2)); } catch(e) {} }
function uid() { return (Date.now().toString(36) + Math.random().toString(36).substr(2, 4)).toUpperCase(); }

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'VoterQR running', voters: DB.voters.length }));

// ── Generate & serve QR as static PNG ─────────────────────────────────────────
// Generates a real .png file served by Express static with correct Content-Type
async function generateQR(voterId, host) {
  const baseUrl = DB.settings.checkinUrl || `https://${host}`;
  const checkinUrl = `${baseUrl}/checkin?voter=${voterId}`;
  const filePath = path.join(QR_DIR, `${voterId}.png`);
  await QRCode.toFile(filePath, checkinUrl, { type: 'png', width: 400, margin: 2 });
  return `/qrcodes/${voterId}.png`;
}

// ── Voters ────────────────────────────────────────────────────────────────────
app.get('/api/voters', (req, res) => res.json(DB.voters));
app.post('/api/voters', (req, res) => {
  const v = { id: uid(), firstName: '', lastName: '', phone: '', address: '', segments: [],
    checkedIn: false, checkInTime: null,
    followUp: { status: 'pending', notes: '', lastContactDate: null }, ...req.body };
  DB.voters.push(v); saveDB(); res.json(v);
});
app.post('/api/voters/import', (req, res) => {
  const list = req.body.voters || [], segId = req.body.segmentId || null;
  list.forEach(v => DB.voters.push({
    id: uid(), firstName: v.firstName||'', lastName: v.lastName||'',
    phone: v.phone||'', address: v.address||'', segments: segId ? [segId] : [],
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
app.post('/api/voters/:id/checkin', (req, res) => {
  const v = DB.voters.find(v => v.id === req.params.id);
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

// ── Settings ──────────────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => res.json(DB.settings));
app.put('/api/settings', (req, res) => {
  DB.settings = { ...DB.settings, ...req.body }; saveDB(); res.json(DB.settings);
});

// ── EZTexting ─────────────────────────────────────────────────────────────────
function ezBasicAuth(u, p) {
  return 'Basic ' + Buffer.from(u + ':' + p).toString('base64');
}

// POST /send-mms
// Generates a real PNG file → served by Express static (Content-Type: image/png, no charset)
// Passes that URL to EZTexting as mediaUrl
app.post('/send-mms', async (req, res) => {
  const { username, password, phone, message, voterId } = req.body;
  if (!username || !password || !phone || !message || !voterId)
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  try {
    const cleanPhone = phone.replace(/\D/g, '').replace(/^1/, '');
    const host = req.headers.host;

    // Generate QR as real .png file, get the static file path
    const qrPath = await generateQR(voterId, host);
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
    console.log('EZTexting response:', sendRes.status, JSON.stringify(data));

    if (!sendRes.ok)
      return res.status(400).json({ success: false, error: JSON.stringify(data) });
    return res.json({ success: true });
  } catch(err) {
    console.error('send-mms error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /send-sms
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
    if (!sendRes.ok)
      return res.status(400).json({ success: false, error: JSON.stringify(data) });
    return res.json({ success: true });
  } catch(err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── SPA ───────────────────────────────────────────────────────────────────────
app.get('/checkin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'checkin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`VoterQR running on port ${PORT}`));
