// Cobalt Studio — content pillars, platform rules, and the seeded script bank.
// Everything here is starter content. Edit it in the app; the app persists to data.json.

const PILLARS = {
  tech: {
    key: 'tech',
    name: 'Tech & AI for Small Business',
    color: '#2563eb',
    share: 0.30,
    voice: 'Practical, no-hype. You are the guy who actually implements this stuff, not the guy reposting AI news.',
    platforms: ['tiktok', 'instagram', 'facebook', 'youtube_shorts', 'linkedin'],
  },
  marketing: {
    key: 'marketing',
    name: 'Digital Marketing & SEO',
    color: '#0d9488',
    share: 0.30,
    voice: 'Specific and testable. Every tip should be something a business owner can do before lunch.',
    platforms: ['tiktok', 'instagram', 'facebook', 'youtube_shorts', 'linkedin'],
  },
  entrepreneur: {
    key: 'entrepreneur',
    name: 'Entrepreneur Lessons',
    color: '#7c3aed',
    share: 0.15,
    voice: 'Honest, earned. Ten years of agency scars, Navy discipline, RGV roots. Never a guru.',
    platforms: ['tiktok', 'instagram', 'facebook', 'youtube_shorts', 'linkedin'],
  },
  nostalgia: {
    key: 'nostalgia',
    name: '90s Nostalgia',
    color: '#db2777',
    share: 0.15,
    voice: 'Fun and self-aware. The 90s hook earns the view; the brand point lands the last 5 seconds.',
    platforms: ['tiktok', 'instagram', 'facebook', 'youtube_shorts'],
  },
  dads: {
    key: 'dads',
    name: 'RGV Dads',
    color: '#ea580c',
    share: 0.10,
    voice: 'Warm, community-first. Dad jokes stay rare so they keep landing.',
    platforms: ['tiktok', 'instagram', 'facebook', 'youtube_shorts'],
  },
  pro: {
    key: 'pro',
    name: 'Professional (LinkedIn only)',
    color: '#1e40af',
    share: 0.0, // scheduled separately, not from the shorts pool
    voice: 'Peer-to-peer with other operators. No hooks, no trends. Point of view + receipts.',
    platforms: ['linkedin'],
  },
};

const PLATFORMS = {
  tiktok: {
    key: 'tiktok', name: 'TikTok', aspect: '9:16', maxSec: 600, sweetSpotSec: [21, 45],
    captionLimit: 2200, hashtags: 4,
    autoPost: 'needs-approval',
    notes: 'Hook in the first 1.5s. Use trending sounds from inside the app, never uploaded audio.',
  },
  instagram: {
    key: 'instagram', name: 'Instagram Reels', aspect: '9:16', maxSec: 900, sweetSpotSec: [15, 45],
    captionLimit: 2200, hashtags: 5,
    autoPost: 'api-ready',
    notes: 'Only 5–90s at 9:16 lands in the Reels tab. Business/Creator account + linked Page required.',
  },
  facebook: {
    key: 'facebook', name: 'Facebook Reels', aspect: '9:16', maxSec: 900, sweetSpotSec: [15, 60],
    captionLimit: 5000, hashtags: 2,
    autoPost: 'api-ready',
    notes: 'Posts to the Page, not the personal profile. Best-performing pillar here is RGV Dads.',
  },
  linkedin: {
    key: 'linkedin', name: 'LinkedIn', aspect: '1:1 or 9:16', maxSec: 600, sweetSpotSec: [30, 90],
    captionLimit: 3000, hashtags: 3,
    autoPost: 'needs-approval',
    notes: 'Professional pillar only. No trend audio, no dad jokes. Text posts outperform video here.',
  },
  youtube_shorts: {
    key: 'youtube_shorts', name: 'YouTube Shorts', aspect: '9:16', maxSec: 180, sweetSpotSec: [20, 60],
    captionLimit: 100, hashtags: 3,
    autoPost: 'api-ready',
    notes: 'Title is the hook — it is searchable. Shorts are the discovery engine for the long-form channel.',
  },
  youtube_long: {
    key: 'youtube_long', name: 'YouTube (long-form)', aspect: '16:9', maxSec: 3600, sweetSpotSec: [480, 900],
    captionLimit: 5000, hashtags: 3,
    autoPost: 'api-ready',
    notes: 'Monthly anchor content. Never use trend audio here — copyright claims.',
  },
};

// Weekly posting slots. Times are local (see settings.timezone).
const DEFAULT_SLOTS = [
  { day: 1, time: '11:30', platforms: ['tiktok', 'instagram', 'facebook', 'youtube_shorts'], pillars: ['marketing', 'tech'] },
  { day: 2, time: '08:00', platforms: ['linkedin'], pillars: ['pro'] },
  { day: 2, time: '17:30', platforms: ['tiktok', 'instagram', 'facebook', 'youtube_shorts'], pillars: ['tech', 'entrepreneur'] },
  { day: 3, time: '11:30', platforms: ['tiktok', 'instagram', 'facebook', 'youtube_shorts'], pillars: ['marketing'] },
  { day: 4, time: '08:00', platforms: ['linkedin'], pillars: ['pro'] },
  { day: 4, time: '17:30', platforms: ['tiktok', 'instagram', 'facebook', 'youtube_shorts'], pillars: ['entrepreneur', 'tech'] },
  { day: 5, time: '12:00', platforms: ['tiktok', 'instagram', 'facebook', 'youtube_shorts'], pillars: ['nostalgia', 'dads'] },
];

// ── Seeded scripts ────────────────────────────────────────────────────────────
// Each script is written to be read off the teleprompter in one take.
// hook = first 1.5 seconds. Everything lives or dies here.
// Estimated read time assumes ~2.6 words/second at a natural pace.

const SCRIPTS = [
  // ───────────── MARKETING ─────────────
  {
    title: 'Your Google Business Profile is your best salesperson',
    pillar: 'marketing',
    lengthSec: 49,
    hook: 'Your website is not your number one salesperson. This is.',
    body: `Your Google Business Profile. When somebody searches "plumber near me," Google shows the map pack before it shows a single website. That's three businesses. If you're not one of them, you don't exist for that search.

Three things, today. One — add photos. Not stock. Actual photos of your shop, your truck, your team. Businesses with photos get way more calls than ones without.

Two — post something. It's free, it takes ninety seconds, and almost nobody in your category is doing it.

Three — fill out every single field. Services, hours, attributes, all of it. Google rewards a complete profile.`,
    cta: 'Go look at your profile right now. Tell me in the comments what percentage complete it says.',
    onScreen: ['NOT your website', '1. Real photos', '2. Post weekly', '3. 100% complete'],
    broll: 'Screen record of a "near me" search showing the map pack. Then a well-filled-out profile vs. an empty one.',
  },
  {
    title: 'Your reviews are not the problem',
    pillar: 'marketing',
    lengthSec: 47,
    hook: 'You don\'t have a review problem. You have a response problem.',
    body: `Everybody obsesses over their star rating. But here's what actually moves the needle — I've seen a four-point-two rated business outperform a four-point-nine in the same category.

Why? The four-point-two responded to every review. Every single one. Good ones, bad ones, the ones that clearly had the wrong business.

Two reasons that works. Google reads your responses as fresh content on your profile. And a human reading reviews sees an owner who's paying attention, which is more convincing than a perfect score nobody stands behind.

Bad review comes in, you respond within twenty-four hours. Short, no excuses, offer to fix it offline.`,
    cta: 'How many of your reviews have a response? Be honest.',
    onScreen: ['4.2 ⭐ beat 4.9 ⭐', 'Respond to ALL of them', '24 hour rule'],
    broll: 'Side-by-side of a review page with responses vs. one with none.',
  },
  {
    title: 'The homepage mistake costing you calls',
    pillar: 'marketing',
    lengthSec: 48,
    hook: 'SEO isn\'t dead. Your homepage is just bad.',
    body: `I pull up a business site and the headline says "Welcome to our website. We provide quality service with integrity."

Cool. What do you do? Where? For who?

Google can't rank that, and a human can't tell in three seconds whether to call you. Both problems, one fix.

Your headline should say what you do, where you do it, and who it's for. "Commercial HVAC repair in Brownsville for restaurants and retail." That's it. That's the whole trick.

You just told Google exactly what to rank you for, and you told the visitor whether they're in the right place. Nobody was ever confused into buying something.`,
    cta: 'Drop your headline in the comments. I\'ll tell you if it passes.',
    onScreen: ['"Welcome to our website" ❌', 'WHAT + WHERE + WHO', 'Nobody buys confused'],
    broll: 'Screen record: a vague homepage headline, then rewrite it live on screen.',
  },
  {
    title: 'Call tracking: the leak nobody checks',
    pillar: 'marketing',
    lengthSec: 58,
    hook: 'You\'re spending money on ads and you have no idea which ones make the phone ring.',
    body: `If your phone number is the same everywhere — website, Google, Facebook, that flyer — every call comes in as a mystery. You're guessing which channel is working, and guessing is how budget gets wasted for years.

Call tracking fixes it. You get a different forwarding number for each source. Rings the same phone, but now you know: eleven calls from Google, two from Facebook, zero from the flyer.

Suddenly the decision makes itself. And this is under fifty bucks a month for most small businesses.

The reason this matters more than any other analytics thing — for most local businesses the phone call IS the sale. If you're not tracking the phone, you're not tracking revenue.`,
    cta: 'If you run ads and don\'t track calls, you\'re flying blind. Say "track" and I\'ll send you the setup.',
    onScreen: ['Same number everywhere = blind', 'Google: 11 · FB: 2 · Flyer: 0', 'The phone IS the sale'],
    broll: 'Simple graphic: one phone, three colored numbers pointing at it.',
  },

  // ───────────── TECH ─────────────
  {
    title: 'The AI tool that replaced a $2,000 contractor',
    pillar: 'tech',
    lengthSec: 62,
    hook: 'I cancelled a two thousand dollar a month contract and replaced it with a twenty dollar tool.',
    body: `Before anybody yells at me — I didn't fire a person. This was a vendor doing something a machine should have been doing.

Here's the actual job. Every month somebody pulled data out of four different platforms, pasted it into a spreadsheet, and made a client report. Forty hours of work to move numbers from one box to another.

That's not strategy. That's copy and paste with extra steps.

Now it's automated. The reports build themselves, and the humans on my team spend that time on the part a machine can't do — deciding what the numbers mean and what we change because of it.

That's the actual AI opportunity for small business. Not replacing your people. Deleting the work that was never worth a human's time.`,
    cta: 'What\'s the most mind-numbing repetitive task in your business? Comment it, I\'ll tell you if it\'s automatable.',
    onScreen: ['$2,000/mo → $20/mo', 'Copy-paste with extra steps', 'Delete the work, not the people'],
    broll: 'Screen record of a spreadsheet being filled manually, then the automated version running.',
  },
  {
    title: 'Stop paying for a website you can\'t edit',
    pillar: 'tech',
    lengthSec: 56,
    hook: 'If you have to email somebody to change your phone number on your own website, you got scammed.',
    body: `I'm not being dramatic. I've seen businesses pay two hundred a month for years — hosting, maintenance, "support" — and every single change is a ticket, a wait, and sometimes a bill.

You don't own that website. You're renting access to your own business information.

Here's the test. Log in. Can you change your hours? Add a photo? Update a price? If you can't do all three in ten minutes, you're in a bad deal.

A modern site should be yours. You should have the login, the domain should be in your name, and the content should be editable by a normal human.

And listen — check whose name the domain is registered in. That one ruins people.`,
    cta: 'Go check who owns your domain. Right now. I\'ll wait.',
    onScreen: ['Can you edit it? ❌', 'Hours · Photos · Prices', 'Who owns your domain?'],
    broll: 'Screen record of a WHOIS lookup, then a simple CMS edit taking 20 seconds.',
  },
  {
    title: 'Three AI prompts that write a month of emails',
    pillar: 'tech',
    lengthSec: 56,
    hook: 'Three prompts. One month of emails. Twenty minutes.',
    body: `Prompt one — the brain dump. "Here are the ten questions customers ask me most. Turn each one into a short email that answers it and ends with one clear next step." You already know the questions. You answer them all day.

Prompt two — the voice fix. Paste in three things you've actually written. "Rewrite these emails in this voice." This is the step everybody skips, and it's why AI emails sound like AI emails.

Prompt three — the subject lines. "Give me five subject lines for each, under forty characters, no clickbait." Pick the one you'd actually open.

That's it. You just built a month of email in the time it takes to eat lunch. And every one of them answers a real question a real customer asked you.`,
    cta: 'Save this one. You\'ll use it Monday.',
    onScreen: ['1. Brain dump', '2. Match your voice ← nobody does this', '3. Subject lines'],
    broll: 'Screen record of the three prompts running back to back.',
  },

  // ───────────── ENTREPRENEUR ─────────────
  {
    title: 'Everyone said moving back was career suicide',
    pillar: 'entrepreneur',
    lengthSec: 58,
    hook: 'I left the Austin tech scene to move back to Brownsville. Everybody told me I was killing my career.',
    body: `The argument made sense on paper. Austin had the clients, the salaries, the network. The Valley had — in their words — nothing.

Here's what they got wrong. They were measuring the market by what was already there instead of what nobody was doing yet.

When I came back, almost nobody down here was doing real SEO. Businesses were buying websites that couldn't be found. That's not a small market. That's an unserved one, and those are the best kind.

Ten years later the agency is still here, and the Valley didn't need to become Austin for that to work.

If you're from a place people tell you to leave — look at what's missing instead of what's there. The gap is the opportunity.`,
    cta: 'Where are you building from? Tell me your city.',
    onScreen: ['"Career suicide"', 'Unserved ≠ small', 'Look for the gap'],
    broll: 'B-roll of Brownsville, the office, downtown. Golden hour if possible.',
  },
  {
    title: 'How I price work now vs. when I started',
    pillar: 'entrepreneur',
    lengthSec: 55,
    hook: 'When I started I priced by the hour. That was the most expensive mistake I ever made.',
    body: `Hourly pricing punishes you for getting good. I spent years getting faster, and my reward was making less money for the same result. That's a broken incentive.

Worse, it makes the client watch the clock instead of the outcome. Every conversation becomes about hours instead of what it's actually worth.

Now I price the outcome. If the work is worth fifty thousand a year to your business, the fee is a fraction of that, and it has nothing to do with how many hours it takes me.

Here's the part that took me too long to learn. The moment I stopped charging for time, I started being honest about which projects were actually worth doing — mine and theirs.`,
    cta: 'Still charging hourly? Tell me why, genuinely curious.',
    onScreen: ['Hourly punishes speed', 'Client watches clock, not outcome', 'Price the result'],
    broll: 'Simple text-on-screen. This one is a talking head — let the face carry it.',
  },
  {
    title: 'The first hire that actually changes things',
    pillar: 'entrepreneur',
    lengthSec: 50,
    hook: 'Your first hire should not be someone who does what you do.',
    body: `Everybody's instinct is to clone themselves. You're drowning in the work, so you hire another you.

Wrong move. Now you have two people doing the delivery and still nobody handling the mess that's actually slowing you down.

Your first hire should take the work you're worst at and least willing to do. For most owners that's the admin — invoicing, scheduling, follow-up, the inbox.

It feels backwards because it doesn't add capacity to the thing you sell. But it gives you back the hours you were spending badly, and you spend those hours on sales and delivery, which is the whole point.

Hire your weakness before you hire your strength.`,
    cta: 'What would you hand off first? Comment it.',
    onScreen: ['Don\'t clone yourself', 'Hire your weakness first', 'Buy back the bad hours'],
    broll: 'Talking head. Maybe a shot of a messy inbox on screen.',
  },

  // ───────────── 90s NOSTALGIA ─────────────
  {
    title: 'Dial-up vs. your website today',
    pillar: 'nostalgia',
    lengthSec: 42,
    hook: '[Dial-up modem sound] If you\'re under thirty you have no idea what that is.',
    body: `That's what the internet sounded like in 1997. You waited forty-five seconds for one page to load and you were fine with it. You went and made a sandwich.

Here's the part that should bother you. In 2026, if your site takes more than three seconds, people leave. Three. Seconds.

We had more patience with a screaming modem than we do with your homepage.

So go run your site through PageSpeed Insights right now. If it's over three seconds, you're losing people who never even saw what you sell.`,
    cta: 'Comment your load time. Loser buys tacos.',
    onScreen: ['1997: 45 seconds 😌', '2026: 3 seconds 😤', 'Check your PageSpeed'],
    broll: 'Dial-up sound (use TikTok\'s native sound library, NOT an uploaded file). Old computer footage, then a loading spinner.',
    audioNote: 'Pick the dial-up sound from inside TikTok/IG. Do not upload audio — YouTube will claim it.',
  },
  {
    title: 'Explaining SEO with Blockbuster',
    pillar: 'nostalgia',
    lengthSec: 43,
    hook: 'SEO is just Blockbuster. Let me explain.',
    body: `Friday night, 1998. You walk into Blockbuster. What's the first thing you see? New releases. Front wall, eye level, facing out.

Everything else is in the back, spine-out, alphabetical, where you have to already know what you're looking for.

That front wall is page one of Google. The back shelves are page two.

Nobody browsed the back shelves on a Friday night. They grabbed what was in front of them and went home.

That's it. That's search. The businesses on that front wall aren't necessarily better — they just did the work to get placed there.`,
    cta: 'What movie were you grabbing off that wall? Go.',
    onScreen: ['New releases = page 1', 'Back shelves = page 2', 'Nobody browsed the back'],
    broll: 'Blockbuster interior footage (stock), then a Google results page with the same framing.',
  },
  {
    title: '90s song + marketing punchline [FLEX SLOT]',
    pillar: 'nostalgia',
    lengthSec: 22,
    hook: '[Trending 90s sound drops] Me explaining to a client why we\'re not buying followers.',
    body: `This one is a format, not a fixed script — pick whatever 90s track is trending in the app that week and match the beat drop to the punchline.

Rotation of punchlines that stay on-brand:
• "Me explaining why we're not buying followers"
• "Client: can we rank number one by Friday"
• "When the website they paid $8,000 for has no phone number on it"
• "Watching a business owner discover their Google profile is unclaimed"
• "Me at 2am reading an analytics dashboard nobody asked for"

Shoot five reaction takes in one go — no dialogue, just the face and the timing. Edit the audio on later.`,
    cta: 'Tag someone who needs to hear this.',
    onScreen: ['Punchline as the caption overlay'],
    broll: 'Pure reaction shots. Shoot 5 variations back-to-back in 3 minutes.',
    audioNote: 'ALWAYS select the trending sound inside TikTok/Instagram. Never post this format to YouTube long-form.',
    flex: true,
  },

  // ───────────── RGV DADS ─────────────
  {
    title: 'Why I started RGV Dads',
    pillar: 'dads',
    lengthSec: 53,
    hook: 'There are a hundred groups for moms in the Valley. I could not find one for dads.',
    body: `And it's not because dads don't need it. It's because we're really bad at admitting we do.

I noticed it when I became a dad myself. Moms had networks — meetups, group chats, people to text at midnight when something was going wrong. Dads had... nothing, mostly. Maybe one friend you'd text about it if you were feeling brave.

So we started RGV Dads. It's not a support group with folding chairs. It's dads showing up, doing stuff with their kids, and figuring out that the other guys are dealing with the same things.

Turns out the thing most dads needed wasn't advice. It was other dads.`,
    cta: 'If you\'re a dad in the Valley — come through. Link in bio.',
    onScreen: ['100 groups for moms', '0 for dads', 'It wasn\'t advice. It was other dads.'],
    broll: 'Photos/footage from actual RGV Dads events. This one needs real faces.',
  },
  {
    title: 'Dad joke — SEO edition [SPORADIC]',
    pillar: 'dads',
    lengthSec: 16,
    hook: 'My kid asked what I do for work.',
    body: `I told him I help businesses show up on Google.

He said, "So you're like... the guy who helps them get found?"

Yeah, buddy.

He goes, "So you're a search party."

...He's grounded.`,
    cta: '',
    onScreen: ['"So you\'re a search party"', '🙃'],
    broll: 'Straight to camera. Deadpan. The pause before "he\'s grounded" is the whole joke.',
    sporadic: true,
  },

  // ───────────── PROFESSIONAL / LINKEDIN ─────────────
  {
    title: 'What ten years of agency work taught me about scope',
    pillar: 'pro',
    lengthSec: 76,
    hook: 'Ten years in, the thing that kills agency relationships isn\'t bad work. It\'s unclear scope.',
    body: `Every failed engagement I've been part of failed the same way. Not because the work was wrong — because nobody agreed what "done" meant.

Here's what changed for us.

One. We define the outcome in the proposal, not the deliverables. "Increase qualified inbound calls" is an outcome. "Twelve blog posts" is a deliverable that may or may not produce anything.

Two. We name what is explicitly out of scope. That paragraph feels awkward to write and it has prevented more conflict than anything else we do.

Three. We agree on the check-in cadence before the work starts. A client who hears from you monthly doesn't get anxious. A client who hears from you when something's wrong learns to dread your name.

None of this is clever. It's just written down before the money changes hands instead of after something goes sideways.

If you run a service business and you're having a hard conversation right now — go read what you actually agreed to. It's usually the answer.`,
    cta: 'What\'s the one clause you\'d add to every contract? I\'ll go first in the comments.',
    onScreen: ['Outcomes, not deliverables', 'Write what\'s OUT of scope', 'Agree the cadence up front'],
    broll: 'Talking head, horizontal or 1:1. Office setting. No trend audio.',
    format: 'square',
  },
  {
    title: 'The AI conversation small business owners are actually having',
    pillar: 'pro',
    lengthSec: 77,
    hook: 'Every AI conversation I have with a small business owner starts in the same wrong place.',
    body: `They ask what tool they should buy.

That's the wrong first question, and it's why so much of this spend goes nowhere.

The right first question is: what do we do every week that's repetitive, rules-based, and doesn't require judgment?

That list is your roadmap. Everything on it is a candidate. Everything not on it — the client relationships, the pricing calls, the hiring decisions — leave it alone, and be suspicious of anyone selling you a tool for it.

What I've watched work, repeatedly, at businesses under fifty people:
— Reporting and data assembly. Highest return, lowest risk, nobody enjoys doing it.
— First-draft content that a human then edits. Not published raw. Ever.
— Intake and routing. Categorizing what comes in so the right person sees it fast.

What I've watched fail:
— Anything customer-facing without a human check.
— Buying the platform before defining the process.

The businesses winning with this aren't the ones with the best tools. They're the ones who knew which twenty percent of their week was worth deleting.`,
    cta: 'Operators — what did you automate that you\'d actually recommend?',
    onScreen: [],
    broll: 'This one works as a LinkedIn text post as well as video. Post it both ways, two weeks apart.',
    format: 'square',
  },
];

// Idea bank — titles only, for future shoots. The app can promote these to full scripts.
const IDEA_BANK = [
  { title: 'The 3-second test every homepage fails', pillar: 'marketing' },
  { title: 'Why your Facebook ads stopped working (it\'s not the algorithm)', pillar: 'marketing' },
  { title: 'Local SEO: the 5-mile radius nobody optimizes for', pillar: 'marketing' },
  { title: 'Reading a Google Analytics report in 60 seconds', pillar: 'marketing' },
  { title: 'The email list you should have started 5 years ago', pillar: 'marketing' },
  { title: 'What "we\'ll do it in-house" actually costs', pillar: 'marketing' },
  { title: 'AI wrote this caption and you couldn\'t tell — here\'s the tell', pillar: 'tech' },
  { title: 'The automation I built in an afternoon that saves 6 hours a week', pillar: 'tech' },
  { title: 'Your CRM is a spreadsheet and that\'s fine (until this happens)', pillar: 'tech' },
  { title: 'Password managers: the 10-minute fix for your biggest risk', pillar: 'tech' },
  { title: 'Why I don\'t recommend the tool everybody\'s posting about', pillar: 'tech' },
  { title: 'Navy taught me one thing that runs my whole business', pillar: 'entrepreneur' },
  { title: 'The client I fired and what it taught me', pillar: 'entrepreneur' },
  { title: 'Revenue is not the number to watch', pillar: 'entrepreneur' },
  { title: 'What I\'d do differently if I started the agency today', pillar: 'entrepreneur' },
  { title: 'Windows 95 startup sound vs. your onboarding process', pillar: 'nostalgia' },
  { title: 'Explaining paid ads with the Sears catalog', pillar: 'nostalgia' },
  { title: 'AOL free trial CDs walked so free lead magnets could run', pillar: 'nostalgia' },
  { title: 'The Trapper Keeper theory of brand consistency', pillar: 'nostalgia' },
  { title: 'MapQuest printouts vs. your customer journey', pillar: 'nostalgia' },
  { title: 'Taking my kid to work: what he thinks I do', pillar: 'dads' },
  { title: 'RGV Dads event recap', pillar: 'dads' },
  { title: 'Hiring: what I look for that isn\'t on the resume', pillar: 'pro' },
  { title: 'The reporting rhythm that keeps clients for 5+ years', pillar: 'pro' },
  { title: 'Why we turned down a national account', pillar: 'pro' },
];

module.exports = { PILLARS, PLATFORMS, DEFAULT_SLOTS, SCRIPTS, IDEA_BANK };
