const https = require('https');

module.exports = function (app) {
  app.post('/api/claude', (req, res) => {
    // express.json() に頼らず生ストリームでボディを読む
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const apiKey = req.headers['x-claude-key'] || '';

      const options = {
        hostname: 'api.anthropic.com',
        port: 443,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      };

      const request = https.request(options, (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          try {
            res.status(response.statusCode).json(JSON.parse(data));
          } catch (e) {
            res.status(500).json({ error: 'Parse error', raw: data.slice(0, 200) });
          }
        });
      });

      request.on('error', (e) => {
        res.status(500).json({ error: e.message });
      });

      request.write(body);
      request.end();
    });
  });
};
