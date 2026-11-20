/* Núcleo do app de revisão: leitura do cartoes.md, fila do dia, teto em minutos, agendamento e cópia de segurança.
   O agendamento é da biblioteca ts-fsrs (lib/, ver lib/ORIGEM.md): aqui só se chama, não se calcula intervalo.
   Sem DOM, para poder ser testado no Node (.contexto/testes.js). */
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica(require('./lib/ts-fsrs.umd.js'));
  else raiz.RV = fabrica(raiz.FSRS);
})(typeof self !== 'undefined' ? self : this, function (FSRS) {
  'use strict';

  var RETENCAO = 0.9;            // chance de lembrar que o agendamento persegue
  var VIRADA_H = 4;              // o dia vira às 4h: revisão de madrugada conta para o dia anterior
  var ADIANTAR_MS = 20 * 60000;  // card em aprendizado que vence em até 20 min aparece antes, se a fila acabou
  var SEG_MAX = 60;              // tempo contado por card: no máximo 60 s (celular esquecido aberto não gasta o teto)
  var SEG_PADRAO = 10;           // estimativa por card enquanto não há histórico
  var TETOS = [5, 10, 15, 20, 30];
  var TETO_PADRAO = 15;
  var NOVOS_PADRAO = 10;
  var ERREI = 1, ACERTEI = 3;    // notas da biblioteca: 1 Again, 2 Hard, 3 Good, 4 Easy
  var FORMATO = 1;

  var agendador = FSRS.fsrs({ request_retention: RETENCAO }); // demais parâmetros: padrão da biblioteca

  /* ---------- leitura do cartoes.md ---------- */

  function erro(linha, msg) {
    var e = new Error('cartoes.md, linha ' + linha + ': ' + msg);
    e.linha = linha;
    return e;
  }

  function slug(s) {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Texto do arquivo -> HTML seguro: escapa tudo, depois **negrito** e quebra de linha.
  function html(s) {
    return esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
  }

  /* Lê o cartoes.md. Falha fechada: qualquer linha fora do formato lança erro com o número da linha. */
  function lerCartoes(md) {
    // Comentários viram linhas em branco, para a numeração continuar batendo com o arquivo.
    md = md.replace(/<!--[\s\S]*?-->/g, function (m) { return m.replace(/[^\n]/g, ''); });
    var linhas = md.split('\n');
    var c = { novosPorDia: NOVOS_PADRAO, baralhos: [], cartoes: [], porId: {} };
    var baralho = null, cru = null, campo = null, codigos = {};

    function fechar() {
      if (!cru) return;
      var temPR = cru.P !== undefined || cru.R !== undefined, temL = cru.L !== undefined;
      if (temPR && temL) throw erro(cru.linha, 'o card "' + cru.codigo + '" mistura pergunta (P:/R:) com lacuna (L:); use um tipo só');
      if (!temPR && !temL) throw erro(cru.linha, 'o card "' + cru.codigo + '" está vazio: falta "P:" e "R:", ou "L:"');
      if (temPR) {
        if (!cru.P || !cru.P.trim()) throw erro(cru.linha, 'o card "' + cru.codigo + '" está sem a pergunta ("P:")');
        if (!cru.R || !cru.R.trim()) throw erro(cru.linha, 'o card "' + cru.codigo + '" está sem a resposta ("R:")');
        if (/\{\{|\}\}/.test(cru.P + cru.R)) throw erro(cru.linha, 'o card "' + cru.codigo + '" usa {{ }} fora de uma linha "L:"');
        incluir({ id: cru.codigo, base: cru.codigo, tipo: 'pergunta', frente: html(cru.P.trim()), verso: html(cru.R.trim()) });
      } else {
        var partes = cru.L.trim().split(/(\{\{[^{}]*\}\})/), lac = [];
        partes.forEach(function (p, i) { if (/^\{\{[^{}]*\}\}$/.test(p)) lac.push(i); });
        if (/\{\{|\}\}/.test(partes.filter(function (p, i) { return lac.indexOf(i) < 0; }).join('')))
          throw erro(cru.linha, 'o card "' + cru.codigo + '" tem {{ ou }} sem par');
        if (!lac.length) throw erro(cru.linha, 'o card "' + cru.codigo + '" é de lacuna e não tem nenhum {{trecho}} marcado');
        lac.forEach(function (alvo, n) {
          var frente = '', verso = '';
          partes.forEach(function (p, i) {
            if (lac.indexOf(i) < 0) { frente += html(p); verso += html(p); return; }
            var dentro = p.slice(2, -2).trim();
            if (!dentro) throw erro(cru.linha, 'o card "' + cru.codigo + '" tem uma lacuna vazia ({{}})');
            if (i === alvo) { frente += '<span class="lacuna">…</span>'; verso += '<b class="lacuna">' + html(dentro) + '</b>'; }
            else { frente += html(dentro); verso += html(dentro); }
          });
          incluir({ id: cru.codigo + '.' + (n + 1), base: cru.codigo, tipo: 'lacuna', frente: frente, verso: verso });
        });
      }
      cru = null; campo = null;
    }

    function incluir(k) {
      k.baralho = baralho.id; k.linha = cru.linha;
      baralho.cartoes.push(k.id); c.cartoes.push(k); c.porId[k.id] = k;
    }

    for (var i = 0; i < linhas.length; i++) {
      var n = i + 1, ln = linhas[i].replace(/\s+$/, ''), m;
      if (!ln.trim()) { campo = null; continue; }
      if ((m = ln.match(/^Novos por dia:\s*(.*)$/))) {
        if (baralho) throw erro(n, '"Novos por dia:" fica no começo do arquivo, antes do primeiro baralho');
        if (!/^\d+$/.test(m[1]) || +m[1] < 1 || +m[1] > 100) throw erro(n, '"Novos por dia:" precisa de um número de 1 a 100');
        c.novosPorDia = +m[1]; continue;
      }
      if ((m = ln.match(/^# (.+)$/))) {
        fechar();
        var nome = m[1].trim(), id = slug(nome);
        if (!id) throw erro(n, 'nome de baralho sem letras: "' + nome + '"');
        if (c.baralhos.some(function (b) { return b.id === id; })) throw erro(n, 'baralho repetido: "' + nome + '"');
        baralho = { id: id, nome: nome, linha: n, cartoes: [] };
        c.baralhos.push(baralho); continue;
      }
      if ((m = ln.match(/^## (.+)$/))) {
        fechar();
        if (!baralho) throw erro(n, 'card antes do primeiro baralho; comece com uma linha "# Nome do baralho"');
        var cod = m[1].trim();
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(cod)) throw erro(n, 'código de card inválido: "' + cod + '". Use letras minúsculas sem acento, números e hífen, como "feo-03"');
        if (codigos[cod]) throw erro(n, 'código de card repetido: "' + cod + '" (já usado na linha ' + codigos[cod] + ')');
        codigos[cod] = n;
        cru = { codigo: cod, linha: n }; campo = null; continue;
      }
      if ((m = ln.match(/^([PRL]):\s?(.*)$/))) {
        if (!cru) throw erro(n, 'linha "' + m[1] + ':" fora de um card; antes dela vai uma linha "## codigo"');
        if (cru[m[1]] !== undefined) throw erro(n, 'o card "' + cru.codigo + '" tem duas linhas "' + m[1] + ':"');
        cru[m[1]] = m[2]; campo = m[1]; continue;
      }
      if (cru && campo) { cru[campo] += '\n' + ln.trim(); continue; }
      throw erro(n, 'linha fora do formato: "' + ln.slice(0, 60) + '"');
    }
    fechar();
    if (!c.cartoes.length) throw erro(1, 'nenhum card encontrado');
    c.baralhos.forEach(function (b) { if (!b.cartoes.length) throw erro(b.linha, 'o baralho "' + b.nome + '" está sem cards'); });
    return c;
  }

  /* ---------- tempo ---------- */

  function p2(n) { return (n < 10 ? '0' : '') + n; }

  // Dia de estudo a que um instante pertence (AAAA-MM-DD, hora local), com a virada às 4h.
  function diaDe(ms) {
    var d = new Date(ms - VIRADA_H * 3600000);
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  }

  // "em 10 min", "amanhã"... sem o "em": 10 min · 3 h · 1 dia · 12 dias · 3 meses · 1,4 ano
  function rotulo(ms) {
    var min = Math.round(ms / 60000);
    if (min < 1) return 'agora';
    if (min < 60) return min + ' min';
    var h = Math.round(ms / 3600000);
    if (h < 24) return h + ' h';
    var d = Math.round(ms / 86400000);
    if (d < 30) return d + (d === 1 ? ' dia' : ' dias');
    if (d < 365) { var me = Math.round(d / 30); return me + (me === 1 ? ' mês' : ' meses'); }
    var a = Math.round(d / 36.5) / 10;
    return String(a).replace('.', ',') + (a < 2 ? ' ano' : ' anos');
  }

  /* ---------- estado ---------- */

  // cartoes[id]: situação de cada card já visto · revisoes: histórico [id, instante, nota, segundos] ·
  // dias[AAAA-MM-DD]: {seg, novos, extraMin} · ajustes.tetoMin · copiaEm: instante da última cópia de segurança
  function estadoVazio() {
    return { formato: FORMATO, cartoes: {}, revisoes: [], dias: {}, ajustes: { tetoMin: TETO_PADRAO }, copiaEm: null };
  }

  function paraLib(k) {
    return { due: new Date(k.due), stability: k.stability, difficulty: k.difficulty, elapsed_days: k.elapsed_days,
      scheduled_days: k.scheduled_days, reps: k.reps, lapses: k.lapses, learning_steps: k.learning_steps,
      state: k.state, last_review: k.last_review == null ? undefined : new Date(k.last_review) };
  }

  function daLib(k) {
    return { due: k.due.getTime(), stability: k.stability, difficulty: k.difficulty, elapsed_days: k.elapsed_days,
      scheduled_days: k.scheduled_days, reps: k.reps, lapses: k.lapses, learning_steps: k.learning_steps,
      state: k.state, last_review: k.last_review ? k.last_review.getTime() : null };
  }

  function dia(E, d) { return E.dias[d] || (E.dias[d] = { seg: 0, novos: 0, extraMin: 0 }); }
  function lerDia(E, d) { return E.dias[d] || { seg: 0, novos: 0, extraMin: 0 }; } // só consulta: não cria o dia

  function agendarUm(anterior, nota, agora) {
    var base = anterior ? paraLib(anterior) : FSRS.createEmptyCard(new Date(agora));
    return daLib(agendador.next(base, new Date(agora), nota).card);
  }

  /* Registra uma resposta. Devolve o que mudou, para a tela gravar: {id, cartao, revisao, dia, antes}.
     "antes" é a situação anterior do card (ou null, se era novo): é o que o desfazer devolve. */
  function responder(E, id, nota, agora, seg) {
    if (nota !== ERREI && nota !== ACERTEI && nota !== 2 && nota !== 4) throw new Error('nota inválida: ' + nota);
    var antes = E.cartoes[id] || null;
    var s = Math.max(0, Math.min(SEG_MAX, Math.round(seg || 0)));
    var d = diaDe(agora), reg = dia(E, d);
    E.cartoes[id] = agendarUm(antes, nota, agora);
    var rev = [id, agora, nota, s];
    E.revisoes.push(rev);
    reg.seg += s;
    if (!antes) reg.novos += 1;
    return { id: id, cartao: E.cartoes[id], revisao: rev, dia: d, antes: antes };
  }

  /* Desfaz a última resposta, a partir do que responder() devolveu. Só vale para a última do histórico. */
  function desfazer(E, feito) {
    var ult = E.revisoes[E.revisoes.length - 1];
    if (!ult || ult !== feito.revisao) throw new Error('só a última resposta pode ser desfeita');
    E.revisoes.pop();
    if (feito.antes) E.cartoes[feito.id] = feito.antes; else delete E.cartoes[feito.id];
    var reg = dia(E, feito.dia);
    reg.seg -= ult[3];
    if (!feito.antes) reg.novos -= 1;
  }

  // Para onde cada nota levaria o card agora (para mostrar no botão): {1: ms até a próxima, 3: ms}
  function previa(E, id, agora) {
    var o = {};
    [ERREI, ACERTEI].forEach(function (n) { o[n] = agendarUm(E.cartoes[id] || null, n, agora).due - agora; });
    return o;
  }

  /* ---------- fila do dia e teto ---------- */

  function tetoSeg(E, agora) { return (E.ajustes.tetoMin + lerDia(E, diaDe(agora)).extraMin) * 60; }
  function gastoSeg(E, agora) { return lerDia(E, diaDe(agora)).seg; }
  function tetoAtingido(E, agora) { return gastoSeg(E, agora) >= tetoSeg(E, agora); }
  function maisMinutos(E, agora, min) { dia(E, diaDe(agora)).extraMin += min; }

  /* Monta a fila do dia, de todos os baralhos. Com filtro (id de um baralho), devolve só a parte dele: assim a soma
     dos baralhos é sempre igual ao total.
     aprendendo: em aprendizado e já vencidos · revisar: vencem hoje ou antes · depois: em aprendizado, vencem mais
     tarde hoje · novos: dentro da cota do dia, um de cada baralho por vez, na ordem do arquivo. */
  function fila(E, C, agora, filtro) {
    var hoje = diaDe(agora), f = { aprendendo: [], revisar: [], novos: [], depois: [] };
    var candidatos = {}, basesHoje = {}, vezesHoje = {};
    for (var j = E.revisoes.length - 1; j >= 0 && diaDe(E.revisoes[j][1]) === hoje; j--)
      vezesHoje[E.revisoes[j][0]] = (vezesHoje[E.revisoes[j][0]] || 0) + 1;
    C.cartoes.forEach(function (k) {
      var s = E.cartoes[k.id];
      // irmãos (lacunas da mesma frase): se um entrou hoje (todas as respostas dele são de hoje), os outros esperam outro dia
      if (s && vezesHoje[k.id] === s.reps) basesHoje[k.base] = 1;
      if (!s) { (candidatos[k.baralho] || (candidatos[k.baralho] = [])).push(k); return; }
      if (s.state === 1 || s.state === 3) (s.due <= agora ? f.aprendendo : f.depois).push(k.id);
      else if (diaDe(s.due) <= hoje) f.revisar.push(k.id);
    });
    var porVenc = function (a, b) { return E.cartoes[a].due - E.cartoes[b].due; };
    f.aprendendo.sort(porVenc); f.revisar.sort(porVenc); f.depois.sort(porVenc);
    var cota = Math.max(0, C.novosPorDia - lerDia(E, hoje).novos), pos = {}, andou = true;
    while (f.novos.length < cota && andou) {
      andou = false;
      for (var b = 0; b < C.baralhos.length && f.novos.length < cota; b++) {
        var lista = candidatos[C.baralhos[b].id] || [], i = pos[C.baralhos[b].id] || 0;
        while (i < lista.length && basesHoje[lista[i].base]) i++;
        if (i < lista.length) { basesHoje[lista[i].base] = 1; f.novos.push(lista[i].id); andou = true; i++; }
        pos[C.baralhos[b].id] = i;
      }
    }
    if (filtro) ['aprendendo', 'revisar', 'novos', 'depois'].forEach(function (parte) {
      f[parte] = f[parte].filter(function (id) { return C.porId[id].baralho === filtro; });
    });
    return f;
  }

  /* Próximo card da sessão: {id, novo} ou {fim: 'teto' | 'feito', restam}. */
  function proximo(E, C, agora, filtro) {
    var f = fila(E, C, agora, filtro);
    var restam = f.aprendendo.length + f.revisar.length + f.novos.length + f.depois.length;
    if (!restam) return { fim: 'feito', restam: 0 };
    if (tetoAtingido(E, agora)) return { fim: 'teto', restam: restam };
    var id = f.aprendendo[0] || f.revisar[0] || f.novos[0];
    if (!id && f.depois.length && E.cartoes[f.depois[0]].due - agora <= ADIANTAR_MS) id = f.depois[0];
    if (!id) return { fim: 'feito', restam: 0, voltam: f.depois.length };
    return { id: id, novo: !E.cartoes[id], restam: restam };
  }

  // Segundos por card: média das últimas 100 respostas; sem histórico, 10 s.
  function segPorCard(E) {
    var r = E.revisoes.slice(-100);
    if (r.length < 20) return SEG_PADRAO;
    return Math.max(3, r.reduce(function (a, x) { return a + x[3]; }, 0) / r.length);
  }

  /* Números da tela inicial, de todos os baralhos ou de um. */
  function resumo(E, C, agora, filtro) {
    var f = fila(E, C, agora, filtro), hoje = diaDe(agora);
    var rever = f.aprendendo.length + f.revisar.length + f.depois.length;
    // card novo passa pela tela pelo menos duas vezes no primeiro dia
    var seg = (rever + 2 * f.novos.length) * segPorCard(E);
    var resta = Math.max(0, tetoSeg(E, agora) - gastoSeg(E, agora));
    var feitas = E.revisoes.filter(function (x) { return diaDe(x[1]) === hoje; }).length;
    return { rever: rever, novos: f.novos.length, total: rever + f.novos.length,
      minutos: Math.ceil(Math.min(seg, resta) / 60), minutosSemTeto: Math.ceil(seg / 60),
      gastoMin: Math.round(gastoSeg(E, agora) / 60), tetoMin: tetoSeg(E, agora) / 60, tetoAtingido: resta <= 0,
      feitasHoje: feitas };
  }

  // Quando volta a haver card, se hoje não há mais: instante do vencimento mais próximo entre os cards já vistos.
  function proximaData(E, C) {
    var m = null;
    C.cartoes.forEach(function (k) { var s = E.cartoes[k.id]; if (s && (m === null || s.due < m)) m = s.due; });
    return m;
  }

  /* ---------- cópia de segurança ---------- */

  // Soma de conferência do conteúdo (cyrb53): pega arquivo cortado ou alterado no caminho.
  function soma(str) {
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0; i < str.length; i++) {
      var ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
  }

  function exportar(E, agora) {
    var dados = JSON.stringify({ formato: E.formato, cartoes: E.cartoes, revisoes: E.revisoes, dias: E.dias, ajustes: E.ajustes });
    return '{"app":"revisao","formato":' + FORMATO + ',"exportadoEm":' + JSON.stringify(new Date(agora).toISOString()) +
      ',"respostas":' + E.revisoes.length + ',"soma":"' + soma(dados) + '","dados":' + dados + '}';
  }

  function num(v) { return typeof v === 'number' && isFinite(v); }

  /* Lê uma cópia de segurança. Falha fechada: arquivo de outro app, cortado, alterado ou fora do formato é recusado
     com a razão, e nada é devolvido pela metade. */
  function restaurar(texto) {
    var o;
    try { o = JSON.parse(texto); } catch (e) { throw new Error('Este arquivo não é uma cópia de segurança do app, ou veio cortado.'); }
    if (!o || o.app !== 'revisao' || !o.dados) throw new Error('Este arquivo não é uma cópia de segurança do app.');
    if (o.formato !== FORMATO) throw new Error('Esta cópia é de outra versão do app (formato ' + o.formato + ').');
    var d = o.dados;
    if (soma(JSON.stringify(d)) !== o.soma) throw new Error('A cópia está danificada: o conteúdo não bate com a conferência gravada nela.');
    if (!d.cartoes || typeof d.cartoes !== 'object' || !Array.isArray(d.revisoes) || !d.dias || !d.ajustes)
      throw new Error('A cópia está incompleta.');
    Object.keys(d.cartoes).forEach(function (id) {
      var k = d.cartoes[id];
      var ok = k && num(k.due) && num(k.stability) && num(k.difficulty) && num(k.elapsed_days) && num(k.scheduled_days) &&
        num(k.reps) && num(k.lapses) && num(k.learning_steps) && [0, 1, 2, 3].indexOf(k.state) >= 0 &&
        (k.last_review === null || num(k.last_review));
      if (!ok) throw new Error('A cópia tem um card com dados inválidos: ' + id + '.');
    });
    d.revisoes.forEach(function (r, i) {
      if (!Array.isArray(r) || r.length !== 4 || typeof r[0] !== 'string' || !num(r[1]) || [1, 2, 3, 4].indexOf(r[2]) < 0 || !num(r[3]))
        throw new Error('A cópia tem uma resposta com dados inválidos (posição ' + (i + 1) + ').');
    });
    Object.keys(d.dias).forEach(function (k) {
      var x = d.dias[k];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !x || !num(x.seg) || !num(x.novos) || !num(x.extraMin)) throw new Error('A cópia tem um dia com dados inválidos: ' + k + '.');
    });
    if (TETOS.indexOf(d.ajustes.tetoMin) < 0) throw new Error('A cópia tem um teto diário inválido.');
    return { formato: FORMATO, cartoes: d.cartoes, revisoes: d.revisoes, dias: d.dias, ajustes: { tetoMin: d.ajustes.tetoMin },
      copiaEm: Date.parse(o.exportadoEm) || null };
  }

  /* Refaz a situação de todos os cards só a partir do histórico de respostas. Serve de prova de que o histórico
     basta para reconstruir as datas (e é o caminho para trocar de versão do agendamento no futuro). */
  function refazerDoHistorico(revisoes) {
    var cartoes = {};
    revisoes.forEach(function (r) { cartoes[r[0]] = agendarUm(cartoes[r[0]] || null, r[2], r[1]); });
    return cartoes;
  }

  // Datas da próxima revisão de cada card, em ordem de id: é o que a restauração tem de devolver igual.
  function datas(E) {
    return Object.keys(E.cartoes).sort().map(function (id) { return id + ' ' + new Date(E.cartoes[id].due).toISOString(); });
  }

  return {
    ERREI: ERREI, ACERTEI: ACERTEI, TETOS: TETOS, TETO_PADRAO: TETO_PADRAO, SEG_MAX: SEG_MAX, RETENCAO: RETENCAO,
    versaoAgendamento: FSRS.FSRSVersion,
    lerCartoes: lerCartoes, diaDe: diaDe, rotulo: rotulo, estadoVazio: estadoVazio,
    responder: responder, desfazer: desfazer, previa: previa,
    fila: fila, proximo: proximo, resumo: resumo, tetoSeg: tetoSeg, gastoSeg: gastoSeg, tetoAtingido: tetoAtingido,
    maisMinutos: maisMinutos, segPorCard: segPorCard, proximaData: proximaData,
    exportar: exportar, restaurar: restaurar, refazerDoHistorico: refazerDoHistorico, datas: datas, soma: soma
  };
});
