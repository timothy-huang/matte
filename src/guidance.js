// Tavily retrieval of the official guidance, with a validated cache fallback.
import fs from 'node:fs';

export const GUIDANCE_URL = 'https://www.bankofireland.com/security-zone/protect-your-business/vendor-email-compromise/';
const CACHE = new URL('../data/guidance-cache.json', import.meta.url);

export function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return null; }
}
export function writeCache(obj) {
  fs.writeFileSync(CACHE, JSON.stringify(obj, null, 2));
}

// Pick the passage about verifying via a known contact on record.
function extractPassage(text) {
  const clean = text.replace(/\r/g, '').replace(/^[ \t]*[*-][ \t]+/gm, '').replace(/[’]/g, "'").replace(/[ \t]+/g, ' ');
  const start = clean.search(/Fraudsters may change an email address/i);
  const anchor = clean.search(/known contact/i);
  if (anchor < 0) return null;
  const from = start >= 0 && start < anchor ? start : Math.max(0, anchor - 300);
  const endIdx = clean.slice(anchor).search(/without verifying it first directly/i);
  const to = endIdx >= 0 ? anchor + endIdx + 'without verifying it first directly'.length : anchor + 600;
  return clean.slice(from, to).replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim() + '.';
}

export async function fetchGuidance() {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error('TAVILY_API_KEY not set');
  const res = await fetch('https://api.tavily.com/extract', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ urls: [GUIDANCE_URL], extract_depth: 'advanced' }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const data = await res.json();
  const r = (data.results || [])[0];
  if (!r || !r.raw_content) throw new Error('Tavily returned no content');
  const excerpt = extractPassage(r.raw_content);
  if (!excerpt) throw new Error('known-contact passage not found in Tavily content');
  const titleMatch = r.raw_content.match(/^#\s*(.+)$/m);
  return {
    title: titleMatch ? titleMatch[1].trim() : 'Vendor Email Compromise - Bank of Ireland',
    url: r.url || GUIDANCE_URL,
    excerpt,
    retrieved_via: 'tavily (live)',
    retrieved_at: new Date().toISOString(),
  };
}
