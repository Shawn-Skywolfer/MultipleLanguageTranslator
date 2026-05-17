module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).send('Method Not Allowed');
    return;
  }
  try {
    const { config, body } = req.body || {};
    const baseUrl = String(config?.baseUrl || '').trim().replace(/\/+$/, '');
    const apiKey = String(config?.apiKey || '').trim();
    if (!baseUrl || !apiKey || !body || typeof body !== 'object') {
      res.status(400).json({ error: 'Missing config or body' });
      return;
    }
    const url = baseUrl + '/chat/completions';
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify(body),
    });
    const text = await upstream.text();
    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    res.setHeader('Content-Type', contentType);
    res.status(upstream.status).send(text);
  } catch (error) {
    res.status(500).json({ error: error.message || String(error) });
  }
};
