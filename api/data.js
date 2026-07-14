// Função serverless do Vercel: lê e grava os dados no Vercel KV (Upstash Redis).
//   GET  /api/data  -> retorna { carros, oficinas, config }
//   POST /api/data  -> salva   { carros, oficinas, config }
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const DATA_KEY = 'controle-carros:data';

async function kv(command) {
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KV_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  if (!res.ok) throw new Error('KV ' + res.status + ': ' + (await res.text()));
  return res.json();
}

module.exports = async (req, res) => {
  if (!KV_URL || !KV_TOKEN) { res.status(500).json({ error: 'kv_nao_configurado', dica: 'Crie um Vercel KV / Upstash e conecte ao projeto.' }); return; }
  try {
    if (req.method === 'GET') {
      const out = await kv(['GET', DATA_KEY]);
      const data = out && out.result ? JSON.parse(out.result) : { carros: [], oficinas: [], config: {} };
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(data);
      return;
    }
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
      if (!body || typeof body !== 'object') { res.status(400).json({ error: 'body_invalido' }); return; }
      const safe = {
        carros: Array.isArray(body.carros) ? body.carros : [],
        oficinas: Array.isArray(body.oficinas) ? body.oficinas : [],
        config: (body.config && typeof body.config === 'object') ? body.config : {}
      };
      await kv(['SET', DATA_KEY, JSON.stringify(safe)]);
      res.status(200).json({ ok: true });
      return;
    }
    res.status(405).json({ error: 'metodo_nao_suportado' });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
