// Sincronização com a planilha do Google "CONTROLE DE MANUTENÇÃO VEÍCULOS" (30/09/2026).
// O administrador preenche a planilha; esta função baixa, lê as linhas e atualiza as manutenções no app.
// Regras:
//  - Só mexe nas manutenções que vieram da planilha (origem 'planilha'). O que foi lançado no app fica intocado.
//  - Linha nova na planilha -> manutenção nova. Linha alterada -> atualiza. Linha apagada -> some do app.
//  - Carro que ainda não existe no app é criado com o nome que está na planilha.
//  - Se a planilha vier vazia ou não abrir, não apaga nada.
// Chamada pelo app ao abrir (e a cada poucos minutos) e pelo Cron da Vercel uma vez por dia.
const XLSX = require('xlsx');

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const DATA_KEY = 'controle-carros:data';
const PLANILHA_ID = process.env.PLANILHA_ID || '1rtJSTgTVZ6-Kp_A_uqUN0YTBP9YYxquTkv_cvna0baI';
const INTERVALO_MIN_MS = 60 * 1000; // não baixa de novo se sincronizou há menos de 1 minuto

async function kv(command) {
  const r = await fetch(KV_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + KV_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
  if (!r.ok) throw new Error('KV ' + r.status + ': ' + (await r.text()));
  return r.json();
}

const norm = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const serialISO = n => new Date(Math.round((n - 25569) * 86400 * 1000)).toISOString().slice(0, 10);
function dataISO(v) {
  if (typeof v === 'number' && v > 30000) return serialISO(v);
  const m = String(v || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) { const a = m[3].length === 2 ? '20' + m[3] : m[3]; return `${a}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  return '';
}
function numero(v) {
  if (typeof v === 'number') return v;
  const s = String(v || '').replace(/[^\d,.-]/g, '');
  if (!s) return null;
  const n = parseFloat(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
  return isNaN(n) ? null : n;
}
function tipoDe(desc) {
  const d = norm(desc);
  if (/oleo/.test(d)) return 'Troca de óleo';
  if (/pneu/.test(d)) return 'Pneus';
  if (/freio|pastilha|disco/.test(d)) return 'Freios';
  if (/bateria/.test(d)) return 'Bateria';
  if (/suspens|amortecedor|manga|barra de direcao|coxim|batente|mola/.test(d)) return 'Suspensão';
  if (/alinhamento|balanceamento|cambagem/.test(d)) return 'Alinhamento e balanceamento';
  if (/filtro/.test(d)) return 'Filtros';
  if (/correia/.test(d)) return 'Correia';
  if (/ar.condicionado|climatiz/.test(d)) return 'Ar-condicionado';
  if (/eletric|tacografo|farol|lampada/.test(d)) return 'Elétrica';
  if (/lavagem|lava/.test(d)) return 'Lavagem';
  if (/revisao/.test(d)) return 'Revisão geral';
  return 'Outros';
}

// lê todas as abas: acha a linha de cabeçalho (Data | Veículo | ...) e pega as linhas abaixo
function lerPlanilha(buf) {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });
  const linhas = [];
  wb.SheetNames.forEach(aba => {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[aba], { header: 1, raw: true, defval: '' });
    let h = -1, col = {};
    for (let i = 0; i < Math.min(rows.length, 30) && h < 0; i++) {
      const r = rows[i].map(norm);
      const iData = r.indexOf('data'), iVei = r.findIndex(x => x.startsWith('veiculo'));
      if (iData >= 0 && iVei >= 0) {
        h = i;
        col = { data: iData, vei: iVei, desc: r.findIndex(x => x.startsWith('detalhamento')), exec: r.findIndex(x => x.startsWith('executor')),
                km: r.indexOf('km'), valor: r.findIndex(x => x.startsWith('valor')), ren: r.findIndex(x => x.startsWith('renovacao')) };
      }
    }
    if (h < 0) return;
    for (let i = h + 1; i < rows.length; i++) {
      const r = rows[i];
      const data = dataISO(r[col.data]), vei = String(r[col.vei] || '').trim(), desc = String(col.desc >= 0 ? r[col.desc] : '').trim();
      if (!data || !vei || !desc) continue;
      const exec = String(col.exec >= 0 ? r[col.exec] : '').trim();
      const [oficina, ...resto] = exec.split(' - ');
      let nf = resto.join(' - ').trim(); if (/^nfs?:?\s*$/i.test(nf)) nf = '';
      const renD = col.ren >= 0 ? r[col.ren] : '', renK = col.ren >= 0 ? r[col.ren + 1] : '';
      const proxData = dataISO(renD), proxKm = numero(renK);
      const obs = [];
      if (!proxData && String(renD).trim()) obs.push(String(renD).trim());
      if (proxKm == null && String(renK).trim() && norm(renK) !== norm(renD)) obs.push('km: ' + String(renK).trim());
      const km = numero(r[col.km]), valor = numero(r[col.valor]);
      linhas.push({ aba, data, veiculo: vei, desc, oficina: (oficina || '').trim(), nf, km: km == null ? '' : String(Math.round(km)), valor: valor == null ? 0 : Math.round(valor * 100) / 100,
                    proxData, proxKm: proxKm == null ? '' : String(Math.round(proxKm)), obsRen: obs.join('; '),
                    chave: norm(`${data}|${vei}|${desc}`) });
    }
  });
  return linhas;
}

function uid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function descricaoDe(l) {
  let t = l.desc + (l.nf ? ` (${l.nf})` : '') + '.';
  if (l.obsRen) t += ` Renovação: ${l.obsRen.toLowerCase()}.`;
  return t;
}

function mesclar(db, linhas) {
  db.carros = db.carros || []; db.oficinas = db.oficinas || []; db.config = db.config || {};
  const cfg = db.config.planilha = db.config.planilha || {};
  const mapa = cfg.mapa = cfg.mapa || {};
  const res = { linhas: linhas.length, novos: 0, atualizados: 0, removidos: 0, carrosNovos: [] };
  const todas = () => db.carros.flatMap(c => (c.manutencoes || []).map(m => ({ c, m })));

  // 1) aprende qual carro é cada nome da planilha olhando manutenções que já existem (mesma data e valor)
  linhas.forEach(l => {
    const k = norm(l.veiculo); if (mapa[k] && db.carros.some(c => c.id === mapa[k])) return;
    const achou = todas().filter(({ m }) => m.chavePlanilha === l.chave || (m.data === l.data && Math.abs((+m.valor || 0) - l.valor) < 0.01));
    const ids = [...new Set(achou.map(x => x.c.id))];
    if (ids.length === 1) mapa[k] = ids[0];
  });
  // 2) nomes ainda sem carro: pelo modelo (e ano, se o nome tiver número, ex.: "Saveiro 26")
  const carroDe = nome => {
    const k = norm(nome);
    if (mapa[k] && db.carros.some(c => c.id === mapa[k])) return db.carros.find(c => c.id === mapa[k]);
    let cand = db.carros.filter(c => { const mo = norm(c.modelo); return mo && k.split(' ').includes(mo.split(' ')[0]); });
    const num = (k.match(/\d{2,4}/) || [])[0];
    if (cand.length > 1 && num) cand = cand.filter(c => String(c.ano || '').endsWith(num.slice(-2)));
    if (cand.length === 1) { mapa[k] = cand[0].id; return cand[0]; }
    const novo = { id: uid('car'), fabricante: '', modelo: nome.trim(), versao: '', ano: '', cor: '', placa: '', kmAtual: '', intervalo: '10000', manutencoes: [], abastecimentos: [], origem: 'planilha' };
    db.carros.push(novo); mapa[k] = novo.id; res.carrosNovos.push(nome.trim());
    return novo;
  };
  const oficinaDe = nome => {
    if (!nome) return '';
    const k = norm(nome);
    let o = db.oficinas.find(x => norm(x.nome) === k);
    if (!o) { o = { id: uid('of'), nome: nome.trim(), telefone: '', especialidade: '', endereco: '', obs: '', origem: 'planilha' }; db.oficinas.push(o); }
    return o.id;
  };

  // 3) cria ou atualiza cada linha
  const vistas = new Set();
  linhas.forEach(l => {
    if (vistas.has(l.chave)) return; vistas.add(l.chave);
    const carro = carroDe(l.veiculo); carro.manutencoes = carro.manutencoes || [];
    let m = carro.manutencoes.find(x => x.chavePlanilha === l.chave)
         || carro.manutencoes.find(x => !x.chavePlanilha && x.data === l.data && Math.abs((+x.valor || 0) - l.valor) < 0.01);
    const desc = descricaoDe(l);
    const campos = { data: l.data, km: l.km, oficinaId: oficinaDe(l.oficina), valor: l.valor, proxKm: l.proxKm, proxData: l.proxData };
    if (m) {
      const antes = JSON.stringify(m);
      Object.assign(m, campos);
      if (!m.descricao || m.descricao === m.descPlanilha) m.descricao = desc; // não sobrescreve texto editado no app
      m.descPlanilha = desc; m.chavePlanilha = l.chave; m.origem = 'planilha';
      if (JSON.stringify(m) !== antes) res.atualizados++;
    } else {
      carro.manutencoes.push(Object.assign({ id: uid('mn'), tipo: tipoDe(l.desc), descricao: desc, descPlanilha: desc, chavePlanilha: l.chave, origem: 'planilha' }, campos));
      res.novos++;
    }
    if (l.km && (+l.km) > (+carro.kmAtual || 0)) carro.kmAtual = l.km;
  });

  // 4) linhas apagadas da planilha somem do app (só as que vieram da planilha)
  db.carros.forEach(c => {
    const antes = (c.manutencoes || []).length;
    c.manutencoes = (c.manutencoes || []).filter(m => m.origem !== 'planilha' || vistas.has(m.chavePlanilha));
    res.removidos += antes - c.manutencoes.length;
  });
  return res;
}

module.exports = async (req, res) => {
  if (!KV_URL || !KV_TOKEN) { res.status(500).json({ error: 'kv_nao_configurado' }); return; }
  try {
    const out = await kv(['GET', DATA_KEY]);
    const db = out && out.result ? JSON.parse(out.result) : { carros: [], oficinas: [], config: {} };
    const cfg = (db.config && db.config.planilha) || {};
    const forcar = /[?&]forcar=1/.test(req.url || '');
    if (!forcar && cfg.ultima && Date.now() - Date.parse(cfg.ultima) < INTERVALO_MIN_MS) {
      res.status(200).json({ ok: true, pulado: true, ultima: cfg.ultima }); return;
    }
    const r = await fetch(`https://docs.google.com/spreadsheets/d/${PLANILHA_ID}/export?format=xlsx`, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow' });
    const buf = Buffer.from(await r.arrayBuffer());
    if (!r.ok || !(buf[0] === 0x50 && buf[1] === 0x4b)) { res.status(502).json({ error: 'planilha_nao_abriu', status: r.status }); return; }
    const linhas = lerPlanilha(buf);
    if (!linhas.length) { res.status(200).json({ ok: false, motivo: 'planilha_sem_linhas', nadaApagado: true }); return; }
    // lê de novo logo antes de gravar, pra não perder algo salvo pelo app enquanto baixava a planilha
    const out2 = await kv(['GET', DATA_KEY]);
    const db2 = out2 && out2.result ? JSON.parse(out2.result) : db;
    const resultado = mesclar(db2, linhas);
    db2.config.planilha.ultima = new Date().toISOString();
    db2.config.planilha.resultado = resultado;
    await kv(['SET', DATA_KEY, JSON.stringify(db2)]);
    res.status(200).json(Object.assign({ ok: true, quando: db2.config.planilha.ultima }, resultado));
  } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
};
module.exports.lerPlanilha = lerPlanilha;
module.exports.mesclar = mesclar;
