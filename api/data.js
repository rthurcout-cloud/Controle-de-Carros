// Função serverless do Vercel: lê e grava os dados no Vercel KV (Upstash Redis).
//   GET  /api/data  -> retorna { carros, oficinas, config }
//   POST /api/data  -> salva   { carros, oficinas, config }
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const DATA_KEY = 'controle-carros:data';
const { espelhar } = require('./_planilha');

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
  if (!KV_URL || !KV_TOKEN) {
    // diagnóstico: mostra só os NOMES das variáveis relacionadas (nunca os valores/segredos)
    const nomes = Object.keys(process.env).filter(k => /KV|REDIS|UPSTASH/i.test(k)).sort();
    res.status(500).json({ error: 'kv_nao_configurado', vars_encontradas: nomes, dica: 'Conecte um KV/Upstash Redis ao projeto no Vercel e faça Redeploy.' });
    return;
  }
  try {
    if (req.method === 'GET') {
      const out = await kv(['GET', DATA_KEY]);
      const data = out && out.result ? JSON.parse(out.result) : { carros: [], oficinas: [], config: {} };
      if (data.config) delete data.config.planilhaEscrita; // endereço e senha da ponte com a planilha não saem do servidor
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
      // app -> planilha: manda pra planilha do Google o que foi lançado, editado ou apagado agora
      let planilha = null;
      try {
        const atual = await kv(['GET', DATA_KEY]);
        const velho = atual && atual.result ? JSON.parse(atual.result) : { carros: [], config: {} };
        const cfg = (body.config && body.config.planilhaEscrita) || (velho.config && velho.config.planilhaEscrita) || null;
        if (cfg) safe.config.planilhaEscrita = cfg;
        planilha = await espelhar(velho, safe, cfg);
      } catch (e) { planilha = { erro: String((e && e.message) || e) }; }
      await kv(['SET', DATA_KEY, JSON.stringify(safe)]);
      res.status(200).json({ ok: true, planilha });
      return;
    }
    res.status(405).json({ error: 'metodo_nao_suportado' });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
