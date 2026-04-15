const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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

// ── EZTexting NEW API (a.eztexting.com/v1) ────────────────────────────────────
function ezBasicAuth(username, password) {
  return 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
}

// Download QR image from QR service → upload as raw PNG binary to EZTexting
async function uploadMedia(username, password, imageUrl) {
  // Download the QR image as a buffer
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) return { success: false, error: 'Failed to download QR image: ' + imgRes.status };
  const imgBuffer = await imgRes.buffer();

  // Upload raw PNG bytes with Content-Type: image/png
  const res = await fetch('https://a.eztexting.com/v1/media-files', {
    method: 'POST',
    headers: {
      'Authorization': ezBasicAuth(username, password),
      'Content-Type': 'image/png',
      'Accept': 'application/json'
    },
    body: imgBuffer
  });

  const data = await res.json().catch(() => ({}));
  console.log('Media upload response:', res.status, JSON.stringify(data));

  // EZTexting may return id, mediaFileId, or Id depending on version
  const id = data.id || data.mediaFileId || data.Id || (data.data && data.data.id);
  if (res.ok && id) return { success: true, id };
  return { success: false, error: JSON.stringify(data) };
}

// Send message via new API
async function sendMessage(username, password, phone, message, mediaFileId) {
  const cleanPhone = phone.replace(/\D/g, '').replace(/^1/, '');
  const body = { phoneNumbers: [cleanPhone], message };
  if (mediaFileId) body.mediaFileId = mediaFileId;

  const res = await fetch('https://a.eztexting.com/v1/messages', {
    method: 'POST',
    headers: {
      'Authorization': ezBasicAuth(username, password),
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const data = await res.json().catch(() => ({}));
  console.log('Send message response:', res.status, JSON.stringify(data));
  return { success: res.ok, status: res.status, data };
}

// POST /send-mms
app.post('/send-mms', async (req, res) => {
  const { username, password, phone, message, qrImageUrl } = req.body;
  if (!username || !password || !phone || !message || !qrImageUrl)
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  try {
    const upload = await uploadMedia(username, password, qrImageUrl);
    if (!upload.success)
      return res.status(400).json({ success: false, error: 'Image upload failed: ' + upload.error });
    const send = await sendMessage(username, password, phone, message, upload.id);
    if (!send.success)
      return res.status(400).json({ success: false, error: JSON.stringify(send.data) });
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
    const send = await sendMessage(username, password, phone, message, null);
    if (!send.success)
      return res.status(400).json({ success: false, error: JSON.stringify(send.data) });
    return res.json({ success: true });
  } catch(err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── SPA ───────────────────────────────────────────────────────────────────────
app.get('/checkin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'checkin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`VoterQR running on port ${PORT}`));
