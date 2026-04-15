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

// ── QR Image proxy ────────────────────────────────────────────────────────────
// Serves QR codes with clean Content-Type: image/png (no charset)
// EZTexting fetches this URL when sending MMS
app.get('/qr/:id', async (req, res) => {
  try {
    const baseUrl = DB.settings.checkinUrl || `https://${req.headers.host}`;
    const data = encodeURIComponent(`${baseUrl}/checkin?voter=${req.params.id}`);
    const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&format=png&data=${data}`;
    const imgRes = await fetch(qrApiUrl);
    if (!imgRes.ok) return res.status(502).send('QR generation failed');
    // Pipe directly — avoids Express overriding Content-Type to octet-stream
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=3600'
    });
    imgRes.body.pipe(res);
  } catch(e) {
    res.status(500).send('Error: ' + e.message);
  }
});

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

// ── EZTexting NEW API ─────────────────────────────────────────────────────────
function ezBasicAuth(username, password) {
  return 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
}

// POST /send-mms
// Instead of uploading to EZTexting media library (which has content-type issues),
// we pass our own /qr/:id URL as mediaUrl directly in the message.
// EZTexting fetches it from our server which returns clean image/png.
app.post('/send-mms', async (req, res) => {
  const { username, password, phone, message, voterId, serverUrl } = req.body;
  if (!username || !password || !phone || !message || !voterId)
    return res.status(400).json({ success: false, error: 'Missing required fields' });

  try {
    const cleanPhone = phone.replace(/\D/g, '').replace(/^1/, '');
    const base = serverUrl || DB.settings.checkinUrl || `https://voterqr-proxy-production.up.railway.app`;
    const mediaUrl = `${base}/qr/${voterId}`;

    const body = {
      toNumbers: [cleanPhone],
      message: message,
      mediaUrl: mediaUrl
    };

    console.log('Sending MMS to', cleanPhone, 'with mediaUrl:', mediaUrl);

    const sendRes = await fetch('https://a.eztexting.com/v1/messages', {
      method: 'POST',
      headers: {
        'Authorization': ezBasicAuth(username, password),
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const data = await sendRes.json().catch(() => ({}));
    console.log('Send response:', sendRes.status, JSON.stringify(data));

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
