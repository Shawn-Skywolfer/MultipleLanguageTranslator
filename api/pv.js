const COUNTER_KEY = 'dp_pv_counter';
let memoryCounter = 0;

async function incrViaUpstash() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const endpoint = `${url.replace(/\/+$/, '')}/incr/${encodeURIComponent(COUNTER_KEY)}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Upstash incr failed: ${response.status}`);
  const json = await response.json();
  const value = Number(json?.result);
  if (!Number.isFinite(value)) throw new Error('Invalid Upstash incr response');
  return value;
}

async function getViaUpstash() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const endpoint = `${url.replace(/\/+$/, '')}/get/${encodeURIComponent(COUNTER_KEY)}`;
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Upstash get failed: ${response.status}`);
  const json = await response.json();
  const value = Number(json?.result || 0);
  return Number.isFinite(value) ? value : 0;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    res.status(405).send('Method Not Allowed');
    return;
  }
  try {
    const action = req.method === 'POST' ? 'incr' : String(req.query?.action || 'get');
    let pv;
    if (action === 'incr') {
      const remote = await incrViaUpstash();
      if (remote !== null) pv = remote;
      else pv = ++memoryCounter;
    } else {
      const remote = await getViaUpstash();
      if (remote !== null) pv = remote;
      else pv = memoryCounter;
    }
    res.status(200).json({ pv, mode: process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN ? 'upstash' : 'memory' });
  } catch (error) {
    res.status(500).json({ error: error.message || String(error) });
  }
};

