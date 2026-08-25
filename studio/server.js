const express = require('express');
const cors = require('cors');
const multer = require('multer');
const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const claude = require('./lib/claude');
const { PILLARS, PLATFORMS, DEFAULT_SLOTS, SCRIPTS, IDEA_BANK } = require('./content/seed');

const app = express();
const PORT = process.env.PORT || 3100;

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = process.env.STUDIO_DATA_DIR || path.join(__dirname, 'data');
const RAW_DIR = path.join(DATA_DIR, 'raw');
const CLIP_DIR = path.join(DATA_DIR, 'clips');
for (const d of [DATA_DIR, RAW_DIR, CLIP_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });

// ── ffmpeg ────────────────────────────────────────────────────────────────────
// Prefer the bundled static binary; fall back to whatever is on PATH.
let FFMPEG = 'ffmpeg';
let FFPROBE = 'ffprobe';
try { FFMPEG = require('ffmpeg-static') || 'ffmpeg'; } catch (e) {}
try { FFPROBE = require('ffprobe-static').path || 'ffprobe'; } catch (e) {}

function ffmpegAvailable() {
  return new Promise(resolve => {
    const p = spawn(FFMPEG, ['-version']);
    p.on('error', () => resolve(false));
    p.on('close', code => resolve(code === 0));
  });
}

// ── DB ────────────────────────────────────────────────────────────────────────
const DB_PATH = path.join(DATA_DIR, 'studio.json');
let DB = {
  settings: {
    brand: 'Mauricio Piña · Cobalt Digital Marketing',
    timezone: 'America/Chicago',
    shootDay: 1,            // 0=Sun … 1=Mon
    shootTime: '09:00',
    shootMinutes: 60,
    clipsPerShoot: 10,
    slots: DEFAULT_SLOTS,
    handles: {
      tiktok: '@mauriciopina1', instagram: '', facebook: '',
      linkedin: '', youtube_shorts: '', youtube_long: '',
    },
    anthropicKey: '',       // optional; falls back to ANTHROPIC_API_KEY
  },
  scripts: [],
  ideas: [],
  uploads: [],
  clips: [],
  calendar: [],
};

function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const saved = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      DB = { ...DB, ...saved, settings: { ...DB.settings, ...(saved.settings || {}) } };
    }
  } catch (e) { console.error('loadDB failed:', e.message); }
}
function saveDB() {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(DB, null, 2)); }
  catch (e) { console.error('saveDB failed:', e.message); }
}
function uid() {
  return (Date.now().toString(36) + crypto.randomBytes(3).toString('hex')).toUpperCase();
}

function seedIfEmpty() {
  if (DB.scripts.length === 0) {
    DB.scripts = SCRIPTS.map((s, i) => ({
      id: uid(),
      order: i,
      status: 'ready',        // idea | ready | shot | clipped | scheduled | posted
      shootDate: null,
      format: s.format || 'vertical',
      platforms: PILLARS[s.pillar] ? PILLARS[s.pillar].platforms : ['tiktok'],
      createdAt: new Date().toISOString(),
      ...s,
    }));
  }
  if (DB.ideas.length === 0) {
    DB.ideas = IDEA_BANK.map(i => ({ id: uid(), status: 'idea', ...i }));
  }
  saveDB();
}
loadDB();
seedIfEmpty();

function apiKey() { return DB.settings.anthropicKey || process.env.ANTHROPIC_API_KEY || ''; }
function wordCount(s) { return (s || '').trim().split(/\s+/).filter(Boolean).length; }
function estimateSeconds(script) {
  const words = wordCount(script.hook) + wordCount(script.body) + wordCount(script.cta);
  return Math.round(words / 2.6);
}

// ── Reference data ────────────────────────────────────────────────────────────
app.get('/api/meta', (req, res) => {
  res.json({ pillars: PILLARS, platforms: PLATFORMS });
});

app.get('/api/state', async (req, res) => {
  res.json({
    settings: { ...DB.settings, anthropicKey: DB.settings.anthropicKey ? '••••••••' : '' },
    scripts: DB.scripts,
    ideas: DB.ideas,
    uploads: DB.uploads,
    clips: DB.clips,
    calendar: DB.calendar,
    capabilities: {
      ai: claude.hasKey(apiKey()),
      ffmpeg: await ffmpegAvailable(),
      model: claude.MODEL,
    },
  });
});

app.post('/api/settings', (req, res) => {
  const incoming = { ...req.body };
  // An unchanged masked key must not overwrite the stored one.
  if (incoming.anthropicKey === '••••••••') delete incoming.anthropicKey;
  DB.settings = { ...DB.settings, ...incoming };
  saveDB();
  res.json({ ok: true });
});

// ── Scripts ───────────────────────────────────────────────────────────────────
app.post('/api/scripts', (req, res) => {
  const s = {
    id: uid(),
    status: 'ready',
    order: DB.scripts.length,
    format: 'vertical',
    createdAt: new Date().toISOString(),
    platforms: PILLARS[req.body.pillar] ? PILLARS[req.body.pillar].platforms : ['tiktok'],
    ...req.body,
  };
  DB.scripts.push(s);
  saveDB();
  res.json(s);
});

app.patch('/api/scripts/:id', (req, res) => {
  const s = DB.scripts.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  Object.assign(s, req.body);
  saveDB();
  res.json(s);
});

app.delete('/api/scripts/:id', (req, res) => {
  DB.scripts = DB.scripts.filter(x => x.id !== req.params.id);
  saveDB();
  res.json({ ok: true });
});

app.post('/api/scripts/generate', async (req, res) => {
  const { title, pillar, lengthSec, extraContext, ideaId } = req.body;
  if (!title || !pillar) return res.status(400).json({ error: 'title and pillar required' });
  try {
    const generated = await claude.generateScript(apiKey(), {
      title, pillar,
      lengthSec: lengthSec || 40,
      pillarVoice: PILLARS[pillar] ? PILLARS[pillar].voice : '',
      extraContext,
    });
    if (!generated) {
      return res.status(503).json({
        error: 'No Anthropic API key configured. Add one in Settings, or write the script by hand.',
      });
    }
    const s = {
      id: uid(),
      status: 'ready',
      order: DB.scripts.length,
      format: pillar === 'pro' ? 'square' : 'vertical',
      pillar,
      platforms: PILLARS[pillar] ? PILLARS[pillar].platforms : ['tiktok'],
      createdAt: new Date().toISOString(),
      ...generated,
    };
    DB.scripts.push(s);
    if (ideaId) DB.ideas = DB.ideas.filter(i => i.id !== ideaId);
    saveDB();
    res.json(s);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Shoot planning ────────────────────────────────────────────────────────────
// Builds the run-of-show for one shoot block: ordered by format so you set the
// camera once, with a running time estimate against the shoot budget.
app.post('/api/shoots/plan', (req, res) => {
  const { date, scriptIds } = req.body;
  const chosen = scriptIds && scriptIds.length
    ? scriptIds.map(id => DB.scripts.find(s => s.id === id)).filter(Boolean)
    : DB.scripts.filter(s => s.status === 'ready').slice(0, DB.settings.clipsPerShoot);

  // Vertical first (most of the batch), square/LinkedIn last — one camera move.
  chosen.sort((a, b) => (a.format === b.format ? 0 : a.format === 'vertical' ? -1 : 1));

  let cumulative = 0;
  const runOfShow = chosen.map((s, i) => {
    const spoken = estimateSeconds(s);
    // Real-world: ~3 takes + resets per script.
    const blockMin = Math.max(2, Math.ceil((spoken * 3 + 60) / 60));
    cumulative += blockMin;
    return {
      position: i + 1,
      scriptId: s.id,
      title: s.title,
      pillar: s.pillar,
      format: s.format,
      spokenSec: spoken,
      blockMinutes: blockMin,
      cumulativeMinutes: cumulative,
      overBudget: cumulative > DB.settings.shootMinutes,
    };
  });

  chosen.forEach(s => { s.shootDate = date || null; });
  saveDB();
  res.json({
    date: date || null,
    budgetMinutes: DB.settings.shootMinutes,
    totalMinutes: cumulative,
    runOfShow,
  });
});

// ── Uploads ───────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, RAW_DIR),
  filename: (req, file, cb) => cb(null, `${uid()}${path.extname(file.originalname) || '.mp4'}`),
});
const upload = multer({ storage, limits: { fileSize: 4 * 1024 * 1024 * 1024 } });

function probeDuration(file) {
  return new Promise(resolve => {
    const p = spawn(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', file]);
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('error', () => resolve(null));
    p.on('close', () => {
      const n = parseFloat(out.trim());
      resolve(Number.isFinite(n) ? n : null);
    });
  });
}

app.post('/api/upload', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const duration = await probeDuration(req.file.path);
  const u = {
    id: path.basename(req.file.filename, path.extname(req.file.filename)),
    file: req.file.filename,
    originalName: req.file.originalname,
    size: req.file.size,
    duration,
    shootDate: req.body.shootDate || null,
    uploadedAt: new Date().toISOString(),
  };
  DB.uploads.push(u);
  saveDB();
  res.json(u);
});

// Range-aware streaming so the browser trimmer can scrub without downloading
// the whole file.
app.get('/api/uploads/:id/file', (req, res) => {
  const u = DB.uploads.find(x => x.id === req.params.id);
  if (!u) return res.status(404).end();
  const file = path.join(RAW_DIR, u.file);
  if (!fs.existsSync(file)) return res.status(404).end();

  const size = fs.statSync(file).size;
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { 'Content-Length': size, 'Content-Type': 'video/mp4' });
    return fs.createReadStream(file).pipe(res);
  }
  const match = /bytes=(\d*)-(\d*)/.exec(range) || [];
  const start = parseInt(match[1], 10) || 0;
  const end = match[2] ? parseInt(match[2], 10) : size - 1;
  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': 'video/mp4',
  });
  fs.createReadStream(file, { start, end }).pipe(res);
});

app.delete('/api/uploads/:id', (req, res) => {
  const u = DB.uploads.find(x => x.id === req.params.id);
  if (u) {
    try { fs.unlinkSync(path.join(RAW_DIR, u.file)); } catch (e) {}
    DB.uploads = DB.uploads.filter(x => x.id !== req.params.id);
    saveDB();
  }
  res.json({ ok: true });
});

// ── Clips ─────────────────────────────────────────────────────────────────────
const JOBS = {};

function buildFilter(format, crop) {
  const [w, h] = format === 'square' ? [1080, 1080] : format === 'wide' ? [1920, 1080] : [1080, 1920];
  const xExpr = crop === 'left' ? '0' : crop === 'right' ? '(iw-ow)' : '(iw-ow)/2';
  return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:${xExpr}:(ih-oh)/2,setsar=1`;
}

function renderClip(clip, srcFile) {
  const out = path.join(CLIP_DIR, `${clip.id}.mp4`);
  const duration = Math.max(0.5, clip.endSec - clip.startSec);
  const args = [
    '-y',
    '-ss', String(clip.startSec),
    '-i', srcFile,
    '-t', String(duration),
    '-vf', buildFilter(clip.format, clip.crop),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11',
    '-movflags', '+faststart',
    out,
  ];

  JOBS[clip.id] = { status: 'rendering', progress: 0, error: null };
  const p = spawn(FFMPEG, args);
  let stderr = '';
  p.stderr.on('data', d => {
    stderr += d.toString();
    const m = /time=(\d+):(\d+):(\d+\.?\d*)/.exec(stderr.slice(-400));
    if (m) {
      const done = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
      JOBS[clip.id].progress = Math.min(99, Math.round((done / duration) * 100));
    }
  });
  p.on('error', err => {
    JOBS[clip.id] = { status: 'error', progress: 0, error: `ffmpeg not available: ${err.message}` };
    clip.status = 'error';
    saveDB();
  });
  p.on('close', code => {
    if (code === 0) {
      JOBS[clip.id] = { status: 'done', progress: 100, error: null };
      clip.status = 'rendered';
      clip.file = `${clip.id}.mp4`;
    } else {
      JOBS[clip.id] = { status: 'error', progress: 0, error: stderr.slice(-500) };
      clip.status = 'error';
    }
    saveDB();
  });
}

app.post('/api/clips', (req, res) => {
  const { uploadId, scriptId, title, startSec, endSec, format, crop, platforms } = req.body;
  const u = DB.uploads.find(x => x.id === uploadId);
  if (!u) return res.status(404).json({ error: 'Upload not found' });
  if (!(endSec > startSec)) return res.status(400).json({ error: 'endSec must be greater than startSec' });

  const script = DB.scripts.find(s => s.id === scriptId);
  const clip = {
    id: uid(),
    uploadId, scriptId: scriptId || null,
    title: title || (script ? script.title : 'Untitled clip'),
    pillar: script ? script.pillar : null,
    startSec: Number(startSec),
    endSec: Number(endSec),
    format: format || (script && script.format) || 'vertical',
    crop: crop || 'center',
    platforms: platforms || (script ? script.platforms : ['tiktok']),
    captions: {},
    status: 'queued',
    file: null,
    createdAt: new Date().toISOString(),
  };
  DB.clips.push(clip);
  if (script) script.status = 'clipped';
  saveDB();

  renderClip(clip, path.join(RAW_DIR, u.file));
  res.json(clip);
});

app.get('/api/clips/:id/status', (req, res) => {
  res.json(JOBS[req.params.id] || { status: 'unknown', progress: 0, error: null });
});

app.get('/api/clips/:id/file', (req, res) => {
  const c = DB.clips.find(x => x.id === req.params.id);
  if (!c || !c.file) return res.status(404).end();
  res.sendFile(path.join(CLIP_DIR, c.file));
});

app.get('/api/clips/:id/download', (req, res) => {
  const c = DB.clips.find(x => x.id === req.params.id);
  if (!c || !c.file) return res.status(404).end();
  const safe = c.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 50);
  res.download(path.join(CLIP_DIR, c.file), `${safe}-${c.id}.mp4`);
});

app.delete('/api/clips/:id', (req, res) => {
  const c = DB.clips.find(x => x.id === req.params.id);
  if (c && c.file) { try { fs.unlinkSync(path.join(CLIP_DIR, c.file)); } catch (e) {} }
  DB.clips = DB.clips.filter(x => x.id !== req.params.id);
  DB.calendar = DB.calendar.filter(e => e.clipId !== req.params.id);
  saveDB();
  res.json({ ok: true });
});

app.post('/api/clips/:id/captions', async (req, res) => {
  const c = DB.clips.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const script = DB.scripts.find(s => s.id === c.scriptId) || { title: c.title, pillar: c.pillar };
  const platforms = req.body.platforms || c.platforms;

  let captions = null;
  if (claude.hasKey(apiKey())) {
    try { captions = await claude.generateCaptions(apiKey(), { script, platforms, clipTitle: c.title }); }
    catch (e) { console.error('caption generation failed:', e.message); }
  }
  const usedFallback = !captions;
  if (usedFallback) captions = claude.fallbackCaptions(script, platforms);

  c.captions = { ...c.captions, ...captions };
  saveDB();
  res.json({ captions: c.captions, usedFallback });
});

// ── Calendar ──────────────────────────────────────────────────────────────────
function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Fills the configured weekly slots with rendered clips that aren't scheduled
// yet, matching each slot's preferred pillars first.
app.post('/api/calendar/generate', (req, res) => {
  const weeks = Math.min(8, Math.max(1, Number(req.body.weeks) || 4));
  const from = req.body.from ? new Date(`${req.body.from}T12:00:00`) : new Date();

  const scheduledClipIds = new Set(DB.calendar.map(e => e.clipId));
  const pool = DB.clips.filter(c => c.status === 'rendered' && !scheduledClipIds.has(c.id));
  if (pool.length === 0) {
    return res.json({ created: 0, note: 'No unscheduled rendered clips available yet.' });
  }

  const created = [];
  const cursor = new Date(from);
  cursor.setHours(12, 0, 0, 0);

  for (let w = 0; w < weeks; w++) {
    for (const slot of DB.settings.slots) {
      const d = new Date(cursor);
      const delta = (slot.day - d.getDay() + 7) % 7 + w * 7;
      d.setDate(d.getDate() + delta);
      if (d < from) continue;

      // Prefer a clip whose pillar this slot is meant for.
      let idx = pool.findIndex(c => slot.pillars.includes(c.pillar));
      if (idx === -1) idx = pool.findIndex(c => !slot.pillars.includes('pro') && c.pillar !== 'pro');
      if (idx === -1) continue;
      const clip = pool.splice(idx, 1)[0];

      for (const platform of slot.platforms) {
        const entry = {
          id: uid(),
          date: localDateStr(d),
          time: slot.time,
          platform,
          clipId: clip.id,
          title: clip.title,
          caption: clip.captions[platform] || '',
          status: 'scheduled',
        };
        DB.calendar.push(entry);
        created.push(entry);
      }
    }
  }
  DB.calendar.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  saveDB();
  res.json({ created: created.length, entries: created });
});

app.patch('/api/calendar/:id', (req, res) => {
  const e = DB.calendar.find(x => x.id === req.params.id);
  if (!e) return res.status(404).json({ error: 'Not found' });
  Object.assign(e, req.body);
  if (req.body.status === 'posted' && !e.postedAt) e.postedAt = new Date().toISOString();
  saveDB();
  res.json(e);
});

app.delete('/api/calendar/:id', (req, res) => {
  DB.calendar = DB.calendar.filter(x => x.id !== req.params.id);
  saveDB();
  res.json({ ok: true });
});

app.post('/api/calendar/clear', (req, res) => {
  DB.calendar = DB.calendar.filter(e => e.status === 'posted');
  saveDB();
  res.json({ ok: true });
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  res.json({
    ok: true,
    ai: claude.hasKey(apiKey()),
    ffmpeg: await ffmpegAvailable(),
    counts: {
      scripts: DB.scripts.length, ideas: DB.ideas.length,
      uploads: DB.uploads.length, clips: DB.clips.length,
      calendar: DB.calendar.length,
    },
  });
});

app.listen(PORT, () => {
  console.log(`Cobalt Studio running on http://localhost:${PORT}`);
  ffmpegAvailable().then(ok => {
    if (!ok) console.warn('⚠ ffmpeg not found — clip rendering is disabled. Run: npm install');
  });
  if (!claude.hasKey(apiKey())) {
    console.warn('⚠ No Anthropic API key — captions use templates, script generation is off.');
  }
});
