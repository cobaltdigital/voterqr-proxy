const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'VoterQR Proxy running' });
});

// Send unique MMS to one voter
// POST /send-mms
// Body: { username, password, phone, message, qrImageUrl }
app.post('/send-mms', async (req, res) => {
  const { username, password, phone, message, qrImageUrl } = req.body;
  if (!username || !password || !phone || !message || !qrImageUrl) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  try {
    // Step 1: Upload QR image to EZTexting media library
    const uploadParams = new URLSearchParams({
      User: username,
      Password: password,
      MediaUrl: qrImageUrl
    });

    const uploadRes = await fetch('https://app.eztexting.com/media-library/files?format=json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: uploadParams.toString()
    });

    const uploadData = await uploadRes.json();

    if (!uploadRes.ok || uploadData?.Response?.Status !== 'Success') {
      const errors = uploadData?.Response?.Errors || ['Upload failed'];
      return res.status(400).json({ success: false, error: 'Image upload failed: ' + errors.join(', ') });
    }

    const fileId = uploadData.Response.Entry.ID;

    // Step 2: Send MMS with the FileID
    const cleanPhone = phone.replace(/\D/g, '').replace(/^1/, ''); // strip to 10 digits
    const sendParams = new URLSearchParams({
      User: username,
      Password: password,
      Message: message,
      MessageTypeID: '3', // MMS
      FileID: fileId
    });
    sendParams.append('PhoneNumbers[]', cleanPhone);

    const sendRes = await fetch('https://app.eztexting.com/sending/messages?format=json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: sendParams.toString()
    });

    const sendData = await sendRes.json();
    const ok = sendRes.status === 201 || sendData?.Response?.Status === 'Success';

    if (!ok) {
      const errors = sendData?.Response?.Errors || ['Send failed'];
      return res.status(400).json({ success: false, error: errors.join(', ') });
    }

    return res.json({ success: true, messageId: sendData?.Response?.Entry?.ID });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Send SMS (no image, just link in text)
// POST /send-sms
// Body: { username, password, phone, message }
app.post('/send-sms', async (req, res) => {
  const { username, password, phone, message } = req.body;
  if (!username || !password || !phone || !message) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  try {
    const cleanPhone = phone.replace(/\D/g, '').replace(/^1/, '');
    const params = new URLSearchParams({
      User: username,
      Password: password,
      Message: message,
      MessageTypeID: '1'
    });
    params.append('PhoneNumbers[]', cleanPhone);

    const sendRes = await fetch('https://app.eztexting.com/sending/messages?format=json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    const sendData = await sendRes.json();
    const ok = sendRes.status === 201 || sendData?.Response?.Status === 'Success';

    if (!ok) {
      const errors = sendData?.Response?.Errors || ['Send failed'];
      return res.status(400).json({ success: false, error: errors.join(', ') });
    }

    return res.json({ success: true, messageId: sendData?.Response?.Entry?.ID });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`VoterQR proxy running on port ${PORT}`));
