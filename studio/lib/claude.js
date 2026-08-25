// Claude integration for script + caption generation.
// Degrades to deterministic templates when no API key is configured, so the
// app is fully usable before you ever add a key.

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch (e) { /* optional dep */ }

const MODEL = 'claude-opus-5';

function getClient(apiKey) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key || !Anthropic) return null;
  return new Anthropic({ apiKey: key });
}

function textOf(response) {
  return (response.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();
}

// Models sometimes wrap JSON in prose or fences. Pull out the first object/array.
function parseJSON(raw) {
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : raw).trim();
  try { return JSON.parse(candidate); } catch (e) { /* keep digging */ }
  const start = candidate.search(/[{[]/);
  if (start === -1) return null;
  const opener = candidate[start];
  const closer = opener === '{' ? '}' : ']';
  const end = candidate.lastIndexOf(closer);
  if (end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch (e) { return null; }
}

async function ask(apiKey, { system, prompt, effort = 'medium', maxTokens = 8000 }) {
  const client = getClient(apiKey);
  if (!client) return null;
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    output_config: { effort },
    messages: [{ role: 'user', content: prompt }],
  });
  return textOf(response);
}

const BRAND_SYSTEM = `You write short-form video content for Mauricio Piña — founder of Cobalt Digital Marketing in Brownsville, Texas (Rio Grande Valley), Navy veteran, ten-plus years in SEO and digital marketing, president of RGV Dads.

Voice rules, non-negotiable:
- Practical over hype. He implements this stuff for real clients; he is not an AI-news reposter or a guru.
- Every tip must be something a small business owner can act on before lunch.
- Specific numbers and real examples beat adjectives.
- Short sentences. Spoken rhythm, not written rhythm — this gets read off a teleprompter.
- Local pride without pandering. The Valley is where he chose to build, not a punchline.
- Never use: "game-changer", "unlock", "in today's digital landscape", "let that sink in", "here's the thing" as an opener.
- Hooks must land in under 1.5 seconds of speech. No throat-clearing.`;

async function generateScript(apiKey, { title, pillar, lengthSec = 40, pillarVoice = '', extraContext = '' }) {
  const raw = await ask(apiKey, {
    system: BRAND_SYSTEM,
    effort: 'high',
    prompt: `Write one short-form video script.

Title/idea: ${title}
Pillar: ${pillar}${pillarVoice ? `\nPillar voice: ${pillarVoice}` : ''}
Target spoken length: ${lengthSec} seconds (roughly ${Math.round(lengthSec * 2.6)} words total across hook + body + cta).
${extraContext ? `Extra context: ${extraContext}` : ''}

Return ONLY a JSON object, no prose around it:
{
  "title": "short internal title",
  "hook": "the first line, spoken in under 1.5 seconds",
  "body": "the main script, written to be read aloud in one take, paragraph breaks as \\n\\n",
  "cta": "one line that invites a comment or a specific action",
  "onScreen": ["3 to 4 short text overlays"],
  "broll": "what to shoot or screen-record behind this",
  "lengthSec": ${lengthSec}
}`,
  });
  return parseJSON(raw);
}

async function generateCaptions(apiKey, { script, platforms, clipTitle }) {
  const raw = await ask(apiKey, {
    system: BRAND_SYSTEM,
    effort: 'low',
    prompt: `Write platform-native captions for this video.

Video: ${clipTitle || script.title}
Hook: ${script.hook || ''}
Script body: ${(script.body || '').slice(0, 1500)}
CTA: ${script.cta || ''}

Platforms: ${platforms.join(', ')}

Rules per platform:
- tiktok: 1-2 lines, conversational, ends with the CTA question. 4 hashtags max, lowercase, mix of broad and niche.
- instagram: 2-3 lines with a line break after the first. 5 hashtags on their own line at the end.
- facebook: 2-4 lines, slightly more explanatory, written for an older local audience. 0-2 hashtags.
- linkedin: 3-5 short paragraphs, professional peer-to-peer, no trend language, no emoji beyond one at most. 3 hashtags.
- youtube_shorts: a searchable TITLE under 80 characters (this is the whole caption slot). Front-load the keyword. Then 3 hashtags.
- youtube_long: a full description — 2 sentence summary, then a timestamped outline placeholder, then 3 hashtags.

Return ONLY a JSON object keyed by platform, each value a single caption string with hashtags included:
{ ${platforms.map(p => `"${p}": "..."`).join(', ')} }`,
  });
  return parseJSON(raw);
}

async function suggestClips(apiKey, { transcript, targetCount = 8 }) {
  const raw = await ask(apiKey, {
    system: BRAND_SYSTEM,
    effort: 'high',
    maxTokens: 12000,
    prompt: `Below is a timestamped transcript of a batch recording session. Find the ${targetCount} strongest standalone short-form clips.

A good clip: starts on a hook (not a wind-up), makes one complete point, ends on a line that resolves or invites a reply, and runs 20-55 seconds.

Transcript:
${transcript.slice(0, 100000)}

Return ONLY a JSON array:
[{ "title": "...", "startSec": 0, "endSec": 0, "hook": "the opening line verbatim", "why": "one sentence on why this works", "pillar": "tech|marketing|entrepreneur|nostalgia|dads|pro" }]`,
  });
  const parsed = parseJSON(raw);
  return Array.isArray(parsed) ? parsed : null;
}

// ── Deterministic fallbacks (no API key required) ────────────────────────────

function fallbackCaptions(script, platforms) {
  const tagsFor = {
    tech: ['#smallbusiness', '#aitools', '#businesstips', '#automation'],
    marketing: ['#seo', '#digitalmarketing', '#smallbusinesstips', '#localseo'],
    entrepreneur: ['#entrepreneur', '#businessowner', '#smallbusiness', '#rgv'],
    nostalgia: ['#90s', '#nostalgia', '#millennial', '#marketing'],
    dads: ['#girldad', '#dadlife', '#rgv', '#rgvdads'],
    pro: ['#marketing', '#agencylife', '#smallbusiness'],
  };
  const tags = tagsFor[script.pillar] || tagsFor.marketing;
  const hook = script.hook || script.title;
  const cta = script.cta || '';
  const out = {};
  for (const p of platforms) {
    if (p === 'tiktok') out[p] = `${hook}\n\n${cta}\n\n${tags.slice(0, 4).join(' ')}`;
    else if (p === 'instagram') out[p] = `${hook}\n\n${cta}\n\n${tags.join(' ')}`;
    else if (p === 'facebook') out[p] = `${hook}\n\n${(script.body || '').split('\n\n')[0] || ''}\n\n${cta}`;
    else if (p === 'linkedin') out[p] = `${hook}\n\n${(script.body || '').split('\n\n').slice(0, 3).join('\n\n')}\n\n${cta}\n\n${tags.slice(0, 3).join(' ')}`;
    else if (p === 'youtube_shorts') out[p] = `${script.title}`.slice(0, 80) + `\n${tags.slice(0, 3).join(' ')}`;
    else if (p === 'youtube_long') out[p] = `${hook}\n\n${script.body || ''}\n\n${cta}\n\n${tags.slice(0, 3).join(' ')}`;
    else out[p] = `${hook}\n\n${cta}`;
  }
  return out;
}

module.exports = {
  MODEL,
  hasKey: (apiKey) => Boolean(getClient(apiKey)),
  generateScript,
  generateCaptions,
  suggestClips,
  fallbackCaptions,
};
