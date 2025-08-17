import 'dotenv/config';
import Parser from 'rss-parser';
import { nip19, getPublicKey, finalizeEvent, SimplePool } from 'nostr-tools';

// === Config ===
const FEED = 'https://bitcoinops.org/feed.xml'; // Bitcoin Optech weekly
const RELAYS = (process.env.RELAYS || 'wss://relay.damus.io,wss://relay.primal.net,wss://nos.lol,wss://relay.snort.social')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function buildNote(item) {
  const title = (item.title || 'Bitcoin Optech Newsletter').trim();
  const link = (item.link || '').trim();
  const lines = [];
  lines.push('# Bitcoin Development Digest — via Bitcoin Optech');
  lines.push('');
  lines.push(`• Latest issue: ${title}`);
  if (link) lines.push(`  ${link}`);
  lines.push('');
  lines.push('#Bitcoin #Development #Optech');
  return lines.join('\n');
}

async function fetchLatestOptech() {
  const parser = new Parser();
  const feed = await parser.parseURL(FEED);
  const items = feed?.items || [];
  items.sort((a,b) => new Date(b.isoDate || b.pubDate || 0) - new Date(a.isoDate || a.pubDate || 0));
  return items[0] || null;
}

async function publish(content) {
  const nsec = (process.env.NOSTR_NSEC || '').trim();
  if (!nsec) throw new Error('Missing NOSTR_NSEC');
  const { data: sk } = nip19.decode(nsec); // secret key bytes
  const pk = getPublicKey(sk);
  const event = {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content
  };
  const signed = finalizeEvent(event, sk);
  const pool = new SimplePool();
  const pubs = pool.publish(RELAYS, signed);
  const results = await Promise.allSettled(pubs);
  const ok = results.some(r => r.status === 'fulfilled');
  console.log('Published as npub:', nip19.npubEncode(pk));
  if (!ok) throw new Error('Publish failed on all relays');
}

async function main() {
  const latest = await fetchLatestOptech();
  if (!latest) { console.log('No feed items found'); return; }
  const note = buildNote(latest);
  console.log('\n--- NOTE PREVIEW ---\n');
  console.log(note);
  if (process.argv.includes('--post')) {
    await publish(note);
  } else {
    console.log('\n(Dry run: not posted)');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
