module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).send('Method Not Allowed');
    return;
  }
  try {
    const { config } = req.body || {};
    const baseUrl = String(config?.baseUrl || '').trim().replace(/\/+$/, '');
    const apiKey = String(config?.apiKey || '').trim();
    if (!baseUrl || !apiKey) {
      res.status(400).json({ error: 'Missing config' });
      return;
    }
    const upstream = await fetch(baseUrl + '/models', {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
      },
    });
    const text = await upstream.text();
    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    res.setHeader('Content-Type', contentType);
    res.status(upstream.status).send(text);
  } catch (error) {
    res.status(500).json({ error: error.message || String(error) });
  }
};
