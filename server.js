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

// ── In-memory DB with file backup ──────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'data.json');
let DB = {
  voters: [], segments: [],
  settings: {
    eventName: 'Campaign Event 2026',
    checkinUrl: '',
    ezUser: ''
  }
};

function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) DB = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch(e) { console.log('Fresh DB start'); }
}

function saveDB() {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(DB, null, 2)); } catch(e) {}
}

function uid() {
  return (Date.now().toString(36) + Math.random().toString(36).substr(2, 4)).toUpperCase();
}

loadDB();

// ── Health ──────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'VoterQR running', voters: DB.voters.length }));

// ── Voters ──────────────────────────────────────────────────────────────────
app.get('/api/voters', (req, res) => res.json(DB.voters));

app.post('/api/voters', (req, res) => {
  const v = {
    id: uid(), firstName: '', lastName: '', phone: '', address: '',
    segments: [], checkedIn: false, checkInTime: null,
    followUp: { status: 'pending', notes: '', lastContactDate: null },
    ...req.body
  };
  DB.voters.push(v);
  saveDB();
  res.json(v);
});

app.post('/api/voters/import', (req, res) => {
  const list = req.body.voters || [];
  const segId = req.body.segmentId || null;
  list.forEach(v => {
    DB.voters.push({
      id: uid(), firstName: v.firstName || '', lastName: v.lastName || '',
      phone: v.phone || '', address: v.address || '',
      segments: segId ? [segId] : [],
      checkedIn: false, checkInTime: null,
      followUp: { status: 'pending', notes: '', lastContactDate: null }
    });
  });
  saveDB();
  res.json({ added: list.length, total: DB.voters.length });
});

app.delete('/api/voters/all', (req, res) => {
  DB.voters = [];
  saveDB();
  res.json({ ok: true });
});

app.delete('/api/voters/:id', (req, res) => {
  DB.voters = DB.voters.filter(v => v.id !== req.params.id);
  saveDB();
  res.json({ ok: true });
});

app.put('/api/voters/:id', (req, res) => {
  const v = DB.voters.find(v => v.id === req.params.id);
  if (!v) return res.status(404).json({ error: 'Not found' });
  Object.assign(v, req.body);
  saveDB();
  res.json(v);
});

app.post('/api/voters/:id/checkin', (req, res) => {
  const v = DB.voters.find(v => v.id === req.params.id);
  if (!v) return res.status(404).json({ error: 'Voter not found' });
  const alreadyIn = v.checkedIn;
  if (!alreadyIn) {
    v.checkedIn = true;
    v.checkInTime = new Date().toISOString();
    saveDB();
  }
  res.json({ voter: v, alreadyCheckedIn: alreadyIn });
});

app.put('/api/voters/:id/followup', (req, res) => {
  const v = DB.voters.find(v => v.id === req.params.id);
  if (!v) return res.status(404).json({ error: 'Not found' });
  v.followUp = { ...v.followUp, ...req.body, lastContactDate: new Date().toISOString() };
  saveDB();
  res.json(v);
});

// ── Segments ────────────────────────────────────────────────────────────────
app.get('/api/segments', (req, res) => res.json(DB.segments));

app.post('/api/segments', (req, res) => {
  const s = { id: uid(), name: '', color: '#2563eb', ...req.body };
  DB.segments.push(s);
  saveDB();
  res.json(s);
});

app.delete('/api/segments/:id', (req, res) => {
  DB.segments = DB.segments.filter(s => s.id !== req.params.id);
  DB.voters.forEach(v => { v.segments = (v.segments || []).filter(s => s !== req.params.id); });
  saveDB();
  res.json({ ok: true });
});

// ── Settings ─────────────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => res.json(DB.settings));

app.put('/api/settings', (req, res) => {
  DB.settings = { ...DB.settings, ...req.body };
  saveDB();
  res.json(DB.settings);
});

// ── EZTexting Proxy ──────────────────────────────────────────────────────────
app.post('/send-mms', async (req, res) => {
  const { username, password, phone, message, qrImageUrl } = req.body;
  if (!username || !password || !phone || !message || !qrImageUrl)
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  try {
    const uploadParams = new URLSearchParams({ User: username, Password: password, MediaUrl: qrImageUrl });
    const uploadRes = await fetch('https://app.eztexting.com/media-library/files?format=json', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: uploadParams.toString()
    });
    const uploadData = await uploadRes.json();
    if (!uploadRes.ok || uploadData?.Response?.Status !== 'Success') {
      const errors = uploadData?.Response?.Errors || ['Upload failed'];
      return res.status(400).json({ success: false, error: 'Upload failed: ' + errors.join(', ') });
    }
    const fileId = uploadData.Response.Entry.ID;
    const cleanPhone = phone.replace(/\D/g, '').replace(/^1/, '');
    const sendParams = new URLSearchParams({ User: username, Password: password, Message: message, MessageTypeID: '3', FileID: fileId });
    sendParams.append('PhoneNumbers[]', cleanPhone);
    const sendRes = await fetch('https://app.eztexting.com/sending/messages?format=json', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: sendParams.toString()
    });
    const sendData = await sendRes.json();
    const ok = sendRes.status === 201 || sendData?.Response?.Status === 'Success';
    if (!ok) return res.status(400).json({ success: false, error: (sendData?.Response?.Errors || ['Send failed']).join(', ') });
    return res.json({ success: true, messageId: sendData?.Response?.Entry?.ID });
  } catch(err) { return res.status(500).json({ success: false, error: err.message }); }
});

app.post('/send-sms', async (req, res) => {
  const { username, password, phone, message } = req.body;
  if (!username || !password || !phone || !message)
    return res.status(400).json({ success: false, error: 'Missing fields' });
  try {
    const cleanPhone = phone.replace(/\D/g, '').replace(/^1/, '');
    const params = new URLSearchParams({ User: username, Password: password, Message: message, MessageTypeID: '1' });
    params.append('PhoneNumbers[]', cleanPhone);
    const sendRes = await fetch('https://app.eztexting.com/sending/messages?format=json', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString()
    });
    const sendData = await sendRes.json();
    const ok = sendRes.status === 201 || sendData?.Response?.Status === 'Success';
    if (!ok) return res.status(400).json({ success: false, error: (sendData?.Response?.Errors || ['Failed']).join(', ') });
    return res.json({ success: true });
  } catch(err) { return res.status(500).json({ success: false, error: err.message }); }
});

// ── SPA fallback ─────────────────────────────────────────────────────────────
app.get('/checkin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'checkin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`VoterQR running on port ${PORT}`));
