import 'dotenv/config';
import Parser from 'rss-parser';
import WebSocket from 'ws';               // ✅ polyfill for nostr-tools on Node/Actions
global.WebSocket = WebSocket;

import { nip19, getPublicKey, finalizeEvent, SimplePool } from 'nostr-tools';

// ======= CONFIG =======
const RELAYS = (process.env.RELAYS || 'wss://relay.primal.net,wss://nos.lol,wss://relay.damus.io,wss://relay.nostr.bg,wss://nostr.wine,wss://relay.wellorder.net')
  .split(',').map(s => s.trim()).filter(Boolean);

const SINCE_DAYS = Number(process.env.SINCE_DAYS || 7);      // ✅ weekly window by default
const MAX_PER_CAT = Number(process.env.MAX_PER_CAT || 5);
const HASHTAGS = process.env.HASHTAGS || '#Bitcoin #Development #Lightning #Fedimint #Cashu';

// Sources grouped by category (tweak later if you want)
const CATEGORIES = {
  'Core Protocol': [
    'https://bitcoinops.org/feed.xml',
    'https://github.com/bitcoin/bitcoin/releases.atom'
    // 'https://github.com/bitcoin/bitcoin/commits/master.atom' // optional
  ],
  'Lightning & L2': [
    'https://github.com/lightningnetwork/lnd/releases.atom',
    'https://github.com/ElementsProject/lightning/releases.atom',
    'https://github.com/lightningdevkit/rust-lightning/releases.atom',
    'https://github.com/ACINQ/eclair/releases.atom',
    'https://github.com/ACINQ/phoenix/releases.atom'
    // TEMP disabled: 'https://blog.lightning.engineering/atom.xml' // 404 right now
  ],
  'Federated / Ecash': [
    'https://github.com/fedimint/fedimint/releases.atom',
    'https://github.com/cashubtc/nuts/releases.atom'
  ],
  'Use-cases & Adoption': [
    'https://blog.blockstream.com/rss/'
    // TEMP disabled: 'https://breez.technology/blog/index.xml' // feed parse error currently
  ]
};
// ======================

const cutoff = new Date(Date.now() - SINCE_DAYS * 24 * 60 * 60 * 1000);
const parser = new Parser();

async function parseFeed(url) {
  try {
    const feed = await parser.parseURL(url);
    return (feed?.items || []).map(i => {
      const d = new Date(i.isoDate || i.pubDate || 0);
      return {
        title: (i.title || '').trim(),
        link: (i.link || i.id || '').trim(),
        date: isNaN(d) ? new Date(0) : d,
        source: (i.link || url).replace(/^https?:\/\//,'').split('/')[0]
      };
    });
  } catch (e) {
    console.error('Feed error:', url, e.message);
    return [];
  }
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it.link) continue;
    if (seen.has(it.link)) continue;
    seen.add(it.link);
    out.push(it);
  }
  return out;
}

function formatLines(items) {
  const lines = [];
  for (const it of items) {
    const t = it.title.replace(/\s+/g, ' ').slice(0, 160);
    lines.push(`• ${t}\n  ${it.link}`);
  }
  return lines.join('\n');
}

function parentNoteText(summary) {
  const end = new Date();
  const start = new Date(end.getTime() - SINCE_DAYS * 24 * 60 * 60 * 1000);
  const fmt = d => d.toISOString().slice(0,10);
  const lines = [];
  lines.push(`# Bitcoin Development Digest — ${fmt(start)} → ${fmt(end)}`);
  lines.push('');
  for (const [cat, count] of Object.entries(summary)) {
    lines.push(`• ${cat}: ${count} update${count===1?'':'s'}`);
  }
  lines.push('');
  lines.push(`Replies contain details per category.\n${HASHTAGS}`);
  return lines.join('\n');
}

function childNoteText(category, items) {
  const lines = [];
  lines.push(`## ${category}`);
  lines.push('');
  lines.push(formatLines(items));
  lines.push('');
  lines.push(HASHTAGS);
  return lines.join('\n');
}

function sign(sk, content, tags = []) {
  const event = {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content
  };
  return finalizeEvent(event, sk); // adds id + sig
}

async function publishEvent(event) {
  const pool = new SimplePool({ getTimeout: 8000, getTimeoutInitial: 8000 });
  const pubs = pool.publish(RELAYS, event);
  const results = await Promise.allSettled(pubs);
  RELAYS.forEach((relay, i) => {
    const r = results[i];
    if (r?.status === 'fulfilled') {
      console.log(`[OK]  ${relay}`);
    } else {
      console.log(`[ERR] ${relay} →`, r?.reason?.message || r?.reason || 'unknown error');
    }
  });
  const ok = results.some(r => r.status === 'fulfilled');
  if (!ok) throw new Error('Publish failed on all relays');
}

async function main() {
  // Gather items per category
  const grouped = {};
  for (const [cat, urls] of Object.entries(CATEGORIES)) {
    const all = (await Promise.all(urls.map(parseFeed))).flat();
    const fresh = all.filter(i => i.date >= cutoff).sort((a,b) => b.date - a.date);
    grouped[cat] = dedupe(fresh).slice(0, MAX_PER_CAT);
  }

  const totalPerCat = Object.fromEntries(Object.entries(grouped).map(([k,v]) => [k, v.length]));
  const totalItems = Object.values(totalPerCat).reduce((a,b)=>a+b,0);

  if (totalItems === 0) {
    console.log('No recent items (try increasing SINCE_DAYS).');
    return;
  }

  // ----- PREVIEW (always works, without secrets) -----
  const parentText = parentNoteText(totalPerCat);
  console.log('\n--- PARENT NOTE PREVIEW ---\n');
  console.log(parentText, '\n');
  for (const [cat, items] of Object.entries(grouped)) {
    if (!items.length) continue;
    const childText = childNoteText(cat, items);
    console.log(`\n--- CHILD NOTE PREVIEW (${cat}) ---\n`);
    console.log(childText, '\n');
  }

  // ----- POST ONLY IF --post -----
  if (!process.argv.includes('--post')) {
    console.log('(Dry run: not posting)');
    return;
  }

  const nsec = (process.env.NOSTR_NSEC || '').trim();
  if (!nsec) throw new Error('Missing NOSTR_NSEC');
  const { data: sk } = nip19.decode(nsec);
  const pk = getPublicKey(sk);

  // Parent note
  const parentEvent = sign(sk, parentText);
  await publishEvent(parentEvent);
  console.log('Published parent as npub:', nip19.npubEncode(pk));

  // Child notes per category (reply to parent)
  for (const [cat, items] of Object.entries(grouped)) {
    if (!items.length) continue;
    const childText = childNoteText(cat, items);
    const tags = [['e', parentEvent.id, '', 'reply']]; // NIP-10 reply
    const childEvent = sign(sk, childText, tags);
    await publishEvent(childEvent);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
