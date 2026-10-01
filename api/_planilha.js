// App -> planilha do Google (01/10/2026). Manda pra ponte (Apps Script da planilha) o que foi lançado,
// editado ou apagado no app. O caminho planilha -> app fica no sync-planilha.js.
// Arquivo com "_" no começo: a Vercel não publica como endereço, só serve pra ser usado pelos outros.

const norm = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const chave = (data, veiculo, desc) => norm(`${data}|${veiculo}|${desc}`);

// nome do veículo como está na planilha (o mapa vem da sincronização planilha -> app)
function nomeNaPlanilha(db, carro) {
  const mapa = (db.config && db.config.planilha && db.config.planilha.mapa) || {};
  const k = Object.keys(mapa).find(n => mapa[n] === carro.id);
  if (k) {
    // devolve o nome com a grafia original, se a gente tiver guardado
    const orig = (carro.manutencoes || []).map(m => m.linhaPlanilha && m.linhaPlanilha.veiculo).find(v => v && norm(v) === k);
    return orig || k.replace(/\b\w/g, c => c.toUpperCase());
  }
  return [carro.modelo, carro.ano && String(carro.ano).slice(-2)].filter(Boolean).join(' ') || carro.fabricante || 'Carro';
}

function linhaDe(db, carro, m) {
  const base = m.linhaPlanilha || null;
  const of = (db.oficinas || []).find(o => o.id === m.oficinaId);
  const desc = (base && (m.descricao === m.descPlanilha || !m.descricao)) ? base.desc : (m.descricao || m.tipo || 'Manutenção');
  const executor = (base && m.oficinaId === base.oficinaId) ? base.exec : (of ? of.nome : '');
  return {
    data: m.data || '', veiculo: base ? base.veiculo : nomeNaPlanilha(db, carro), desc, executor,
    km: m.km === '' || m.km == null ? '' : +m.km, valor: m.valor === '' || m.valor == null ? '' : +m.valor,
    renData: m.proxData || '', renKm: m.proxKm === '' || m.proxKm == null ? '' : +m.proxKm,
    renTexto: !m.proxData && base ? (base.renTexto || '') : '', renKmTexto: (m.proxKm === '' || m.proxKm == null) && base ? (base.renKmTexto || '') : ''
  };
}

async function chamar(cfg, corpo) {
  const r = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(Object.assign({ senha: cfg.senha }, corpo)), redirect: 'follow' });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch (e) { throw new Error('a planilha respondeu algo inesperado'); }
  if (!j.ok) throw new Error('planilha: ' + (j.erro || 'erro'));
  return j;
}

const CAMPOS = ['data', 'km', 'valor', 'oficinaId', 'proxKm', 'proxData', 'descricao', 'tipo'];

// compara o banco antigo com o novo e manda as diferenças pra planilha. Marca no novo o que foi escrito.
const MARCAS = ['origem', 'linhaPlanilha', 'chavePlanilha', 'descPlanilha', 'escritoEm', 'pendentePlanilha'];

async function espelhar(velho, novo, cfg) {
  const antes = {};
  (velho.carros || []).forEach(c => (c.manutencoes || []).forEach(m => { antes[m.id] = { c, m }; }));
  // aparelho desatualizado: o que existe no servidor e não veio do aparelho só sai se foi apagado de propósito
  const apagadas = new Set(((novo.config || {}).manutApagadas) || []);
  const carrosApagados = new Set(((novo.config || {}).carrosApagados) || []);
  const idsNovos = new Set();
  (novo.carros || []).forEach(c => (c.manutencoes || []).forEach(m => idsNovos.add(m.id)));
  (velho.carros || []).forEach(cv => {
    let cn = (novo.carros || []).find(c => c.id === cv.id);
    if (!cn) { if (carrosApagados.has(cv.id)) return; cn = JSON.parse(JSON.stringify(cv)); cn.manutencoes = []; novo.carros.push(cn); }
    (cv.manutencoes || []).forEach(m => {
      if (idsNovos.has(m.id) || apagadas.has(m.id)) return;
      cn.manutencoes = cn.manutencoes || []; cn.manutencoes.push(m); idsNovos.add(m.id);
    });
  });
  // o aparelho pode não ter recebido ainda as marcas que o servidor pôs (ligação com a linha da planilha): mantém
  (novo.carros || []).forEach(c => (c.manutencoes || []).forEach(m => {
    const v = antes[m.id]; if (!v) return;
    MARCAS.forEach(k => { if (v.m[k] !== undefined && m[k] === undefined) m[k] = v.m[k]; });
  }));
  if (!cfg || !cfg.url || !cfg.senha) return { pulado: true };
  const res = { adicionados: 0, atualizados: 0, apagados: 0, erros: [] };
  const vistos = new Set();
  for (const carro of (novo.carros || [])) {
    for (const m of (carro.manutencoes || [])) {
      vistos.add(m.id);
      const v = antes[m.id];
      try {
        if (!v || m.pendentePlanilha) {
          // lançada agora no app (ou que falhou antes): escreve uma linha nova
          if (m.linhaPlanilha) continue;
          if (v && !m.pendentePlanilha) continue;
          const l = linhaDe(novo, carro, m);
          await chamar(cfg, { acao: 'adicionar', linha: l });
          Object.assign(m, { origem: 'planilha', pendentePlanilha: false, escritoEm: Date.now(),
            linhaPlanilha: { data: l.data, veiculo: l.veiculo, desc: l.desc, exec: l.executor, oficinaId: m.oficinaId },
            chavePlanilha: chave(l.data, l.veiculo, l.desc) });
          res.adicionados++;
        } else if (m.linhaPlanilha && CAMPOS.some(k => String(v.m[k] == null ? '' : v.m[k]) !== String(m[k] == null ? '' : m[k]))) {
          // editada no app: atualiza a mesma linha na planilha
          const l = linhaDe(novo, carro, m);
          await chamar(cfg, { acao: 'atualizar', antes: m.linhaPlanilha, linha: l });
          Object.assign(m, { escritoEm: Date.now(), linhaPlanilha: Object.assign({}, m.linhaPlanilha, { data: l.data, desc: l.desc, exec: l.executor, oficinaId: m.oficinaId }),
            chavePlanilha: chave(l.data, l.veiculo, l.desc) });
          res.atualizados++;
        }
      } catch (e) {
        if (!v) m.pendentePlanilha = true; // tenta de novo no próximo salvamento
        res.erros.push(String(e.message || e));
      }
    }
  }
  // apagadas no app: apaga a linha na planilha
  for (const id of Object.keys(antes)) {
    if (vistos.has(id) || !apagadas.has(id)) continue;
    const { m } = antes[id];
    if (!m.linhaPlanilha) continue;
    try { await chamar(cfg, { acao: 'apagar', antes: m.linhaPlanilha }); res.apagados++; }
    catch (e) { res.erros.push(String(e.message || e)); }
  }
  return res;
}

module.exports = { espelhar, chamar, chave, norm };
