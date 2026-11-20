/* Tela do app de revisão. A regra (fila, teto, agendamento, cópia de segurança) está em nucleo.js;
   aqui ficam só a tela e a gravação no aparelho. */
(function () {
  'use strict';
  var RV = window.RV, app = document.getElementById('app');
  var C = null;        // cards lidos do cartoes.md
  var E = null;        // histórico e situação dos cards (espelho do que está gravado no aparelho)
  var sessao = null;   // sessão de revisão em andamento
  var tela = 'hoje', recado = '', pendente = null;
  var DIA_MS = 86400000;
  var TRAVA_MS = 400; // os botões de nota ficam onde estava o "Mostrar resposta", e vice-versa: o segundo toque de um toque duplo é ignorado
  var SEMANA = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  var SEM_CURTA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  var MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  var svg = function (d, t) { return '<svg width="' + (t || 24) + '" height="' + (t || 24) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>'; };
  var ICO = {
    ajustes: svg('<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>'),
    fechar: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    voltar: svg('<path d="M15 5l-7 7 7 7"/>'),
    seta: svg('<path d="M9 5l7 7-7 7"/>', 20),
    feito: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
  };

  /* ---------- gravação no aparelho (IndexedDB): cards, respostas e o resto em três gavetas ---------- */
  var banco = null, fila = Promise.resolve();

  function abrirBanco() {
    return new Promise(function (ok, falha) {
      if (!window.indexedDB) return falha(new Error('sem lugar para guardar'));
      var r = indexedDB.open('revisao', 1);
      r.onupgradeneeded = function () {
        var d = r.result;
        d.createObjectStore('cartoes'); d.createObjectStore('revisoes', { autoIncrement: true }); d.createObjectStore('meta');
      };
      r.onsuccess = function () { banco = r.result; ok(); };
      r.onerror = function () { falha(r.error || new Error('não abriu')); };
    });
  }

  // Uma transação: ou grava tudo, ou não grava nada.
  function tx(modo, fn) {
    return new Promise(function (ok, falha) {
      var t = banco.transaction(['cartoes', 'revisoes', 'meta'], modo);
      t.oncomplete = function () { ok(); };
      t.onerror = t.onabort = function () { falha(t.error || new Error('gravação interrompida')); };
      fn(t.objectStore('cartoes'), t.objectStore('revisoes'), t.objectStore('meta'));
    });
  }

  function carregar() {
    var e = RV.estadoVazio(), ids, cartoes, meta = {};
    return tx('readonly', function (ca, re, me) {
      ca.getAllKeys().onsuccess = function (ev) { ids = ev.target.result; };
      ca.getAll().onsuccess = function (ev) { cartoes = ev.target.result; };
      re.getAll().onsuccess = function (ev) { e.revisoes = ev.target.result; };
      ['dias', 'ajustes', 'copiaEm'].forEach(function (k) { me.get(k).onsuccess = function (ev) { meta[k] = ev.target.result; }; });
    }).then(function () {
      ids.forEach(function (id, i) { e.cartoes[id] = cartoes[i]; });
      if (meta.dias) e.dias = meta.dias;
      if (meta.ajustes) e.ajustes = meta.ajustes;
      if (meta.copiaEm) e.copiaEm = meta.copiaEm;
      return e;
    });
  }

  function gravarMeta() {
    return tx('readwrite', function (ca, re, me) { me.put(E.dias, 'dias'); me.put(E.ajustes, 'ajustes'); me.put(E.copiaEm, 'copiaEm'); });
  }
  function gravarResposta(f) {
    return tx('readwrite', function (ca, re, me) {
      ca.put(f.cartao, f.id);
      re.add(f.revisao).onsuccess = function (ev) { f.chave = ev.target.result; };
      me.put(E.dias, 'dias');
    });
  }
  function gravarDesfazer(f) {
    return tx('readwrite', function (ca, re, me) {
      if (f.antes) ca.put(f.antes, f.id); else ca.delete(f.id);
      re.delete(f.chave);
      me.put(E.dias, 'dias');
    });
  }
  function substituirTudo(novo) {
    return tx('readwrite', function (ca, re, me) {
      ca.clear(); re.clear(); me.clear();
      Object.keys(novo.cartoes).forEach(function (id) { ca.put(novo.cartoes[id], id); });
      novo.revisoes.forEach(function (r) { re.add(r); });
      me.put(novo.dias, 'dias'); me.put(novo.ajustes, 'ajustes'); me.put(novo.copiaEm, 'copiaEm');
    });
  }
  // As gravações entram em fila, na ordem em que aconteceram. Falha de gravação para o app: melhor parar que perder resposta calado.
  function gravar(fn) {
    fila = fila.then(fn).catch(function (e) {
      telaErro('Não consegui gravar no aparelho', 'A última resposta pode não ter ficado guardada. Feche o app e abra de novo.', e);
      return new Promise(function () {});
    });
    return fila;
  }

  /* ---------- textos ---------- */
  function hojeTexto(ms) { var d = new Date(ms); return SEMANA[d.getDay()] + ', ' + d.getDate() + ' de ' + MESES[d.getMonth()]; }
  function dataCurta(ms) { var d = new Date(ms - 4 * 3600000); return SEM_CURTA[d.getDay()] + ', ' + d.getDate() + ' de ' + MESES[d.getMonth()]; }
  function diasEntre(a, b) { // dias de estudo entre dois instantes
    var p = function (ms) { var s = RV.diaDe(ms).split('-'); return Date.UTC(+s[0], +s[1] - 1, +s[2]); };
    return Math.round((p(b) - p(a)) / DIA_MS);
  }
  function haQuanto(ms, agora) { var n = diasEntre(ms, agora); return n <= 0 ? 'hoje' : n === 1 ? 'ontem' : 'há ' + n + ' dias'; }
  function plural(n, um, varios) { return n + ' ' + (n === 1 ? um : varios); }
  // O app sabe quando gerou o arquivo da cópia; não tem como saber se ele ficou salvo. Por isso diz "gerada", nunca "guardada".
  function copiaTexto(agora) { return E.copiaEm ? 'Cópia gerada: ' + haQuanto(E.copiaEm, agora) : 'Sem cópia de segurança'; }
  function minTexto(seg) { return seg < 60 ? 'menos de 1 min' : Math.round(seg / 60) + ' min'; }
  function depoisDeHoje(agora) { // o que dizer quando hoje acabou
    var am = RV.resumo(E, C, agora + DIA_MS).total;
    if (am) return 'Amanhã: ' + plural(am, 'card', 'cards');
    var p = RV.proximaData(E, C);
    return p ? 'Próxima revisão: ' + dataCurta(p) : '';
  }

  /* ---------- telas ---------- */
  function telaHoje() {
    var agora = Date.now(), r = RV.resumo(E, C, agora), h = '';
    h += '<header class="topo"><p class="data">' + hojeTexto(agora) + '</p><button class="icone-btn" data-acao="ajustes" aria-label="Ajustes">' + ICO.ajustes + '</button></header>';
    h += '<section class="hoje">';
    if (!r.total) {
      h += '<h1 class="titulo">Em dia</h1><p class="meta">' + (depoisDeHoje(agora) || 'Nenhum card para rever.') + '</p>';
      if (r.feitasHoje) h += '<p class="meta-2">Hoje: ' + plural(r.feitasHoje, 'resposta', 'respostas') + ' em ' + minTexto(r.gastoSeg) + '</p>';
    } else if (r.tetoAtingido) {
      h += '<p class="numero">' + r.total + '</p><p class="numero-rotulo">' + (r.total === 1 ? 'card ficou para depois' : 'cards ficaram para depois') + '</p>' +
        '<p class="meta">Teto de hoje atingido: ' + r.tetoMin + ' min</p>' +
        '<button class="btn btn-2" data-acao="mais">Mais 5 minutos</button>';
    } else {
      h += '<p class="numero">' + r.total + '</p><p class="numero-rotulo">' + (r.total === 1 ? 'card para hoje' : 'cards para hoje') + '</p>' +
        '<p class="meta">Cerca de ' + r.minutos + ' min · teto de ' + r.tetoMin + ' min</p>' +
        '<p class="meta-2">' + [r.rever ? r.rever + ' para rever' : '', r.novos ? plural(r.novos, 'novo', 'novos') : '', r.gastoSeg >= 60 ? minTexto(r.gastoSeg) + ' já feitos hoje' : ''].filter(Boolean).join(' · ') + '</p>' +
        '<button class="btn" data-acao="revisar">Revisar</button>';
    }
    h += '</section><section class="baralhos"><h2 class="rotulo">Baralhos</h2><ul class="lista">';
    C.baralhos.forEach(function (b) {
      var n = RV.resumo(E, C, agora, b.id).total, dentro = '<span class="linha-nome">' + RV_esc(b.nome) + '</span><span class="linha-meta">' + (!n ? 'em dia' : r.tetoAtingido ? n + ' para depois' : n + ' hoje') + '</span>';
      h += n && !r.tetoAtingido ? '<li><button class="linha" data-acao="revisar" data-baralho="' + b.id + '">' + dentro + ICO.seta + '</button></li>'
        : '<li><div class="linha parada">' + dentro + '</div></li>';
    });
    h += '</ul></section>';
    if (E.revisoes.length) h += '<footer class="copia"><p>' + copiaTexto(agora) + '</p><button class="btn-3" data-acao="copia">Guardar cópia</button></footer>';
    return '<main class="tela">' + h + '</main>';
  }

  function telaSessao() {
    var agora = Date.now(), k = C.porId[sessao.atual], total = sessao.feitas + sessao.respostas, h = '';
    var baralho = C.baralhos.filter(function (b) { return b.id === k.baralho; })[0];
    h += '<header class="topo"><button class="icone-btn esq" data-acao="voltar" aria-label="Fechar">' + ICO.fechar + '</button><p class="conta">' + (sessao.restam === 1 ? 'falta 1 card' : 'faltam ' + sessao.restam + ' cards') + '</p></header>';
    h += '<div class="progresso"><i style="width:' + Math.round(100 * sessao.feitas / total) + '%"></i></div>';
    h += '<section class="card" data-acao="' + (sessao.revelado ? '' : 'mostrar') + '"><p class="card-baralho">' + RV_esc(baralho.nome) + '</p>';
    if (!sessao.revelado) h += '<p class="card-texto">' + k.frente + '</p>';
    else if (k.tipo === 'lacuna') h += '<p class="card-texto">' + k.verso + '</p>';
    else h += '<p class="card-texto">' + k.frente + '</p><hr class="card-fio"><p class="card-texto resposta">' + k.verso + '</p>';
    h += '</section><footer class="trilho">';
    if (!sessao.revelado) h += '<button class="btn" data-acao="mostrar">Mostrar resposta</button>';
    else {
      var p = RV.previa(E, sessao.atual, agora);
      h += '<div class="notas"><button class="btn btn-2 nota" data-acao="nota" data-nota="' + RV.ERREI + '"><span>Errei</span><small>volta em ' + RV.rotulo(p[RV.ERREI]) + '</small></button>' +
        '<button class="btn nota" data-acao="nota" data-nota="' + RV.ACERTEI + '"><span>Acertei</span><small>volta em ' + RV.rotulo(p[RV.ACERTEI]) + '</small></button></div>';
    }
    h += '<button class="btn-3 desfazer" data-acao="desfazer"' + (sessao.ultimo ? '' : ' style="visibility:hidden" tabindex="-1" aria-hidden="true"') + '>Desfazer a anterior</button>';
    return '<main class="tela sessao">' + h + '</footer></main>';
  }

  function telaFim() {
    var agora = Date.now(), f = sessao.fim, h = '<section class="fim">';
    var linha = plural(sessao.feitas, 'resposta', 'respostas') + ' · ' + plural(sessao.acertos, 'acerto', 'acertos');
    if (f.fim === 'teto') {
      h += '<h1 class="titulo">Teto de hoje: ' + RV.tetoSeg(E, agora) / 60 + ' min</h1><p class="meta">' + linha + '</p>' +
        '<p class="meta-2">' + (f.restam === 1 ? 'Ficou 1 card para depois' : 'Ficaram ' + f.restam + ' cards para depois') + '</p>';
    } else {
      var outros = sessao.filtro ? RV.resumo(E, C, agora).total : 0;
      var seg = RV.gastoSeg(E, agora) - sessao.seg0;
      h += '<p class="selo">' + ICO.feito + '</p><h1 class="titulo">' + (outros ? 'Baralho feito por hoje' : 'Feito por hoje') + '</h1>' +
        '<p class="meta">' + linha + ' · ' + minTexto(seg) + '</p>' +
        '<p class="meta-2">' + (outros ? 'Ainda há ' + plural(outros, 'card', 'cards') + ' de outros baralhos hoje' : depoisDeHoje(agora)) + '</p>';
    }
    h += '</section><footer class="trilho solto"><button class="btn" data-acao="voltar">Concluir</button>';
    if (f.fim === 'teto') h += '<button class="btn btn-2" data-acao="mais">Mais 5 minutos</button>';
    if (sessao.ultimo) h += '<button class="btn-3 desfazer" data-acao="desfazer">Desfazer a anterior</button>';
    h += '<div class="copia"><p>' + copiaTexto(agora) + '</p><button class="btn-3" data-acao="copia">Guardar cópia</button></div>';
    return '<main class="tela">' + h + '</footer></main>';
  }

  function telaAjustes() {
    var agora = Date.now(), n = E.revisoes.length, h = '';
    h += '<header class="topo"><button class="icone-btn esq" data-acao="voltar" aria-label="Voltar">' + ICO.voltar + '</button><p class="conta"></p></header><h1 class="titulo pagina">Ajustes</h1>';
    h += '<section class="bloco"><h2 class="rotulo">Quantos minutos por dia, no máximo?</h2><div class="opcoes" role="radiogroup">';
    RV.TETOS.forEach(function (t) {
      var m = t === E.ajustes.tetoMin;
      h += '<button class="opcao' + (m ? ' marcada' : '') + '" role="radio" aria-checked="' + m + '" data-acao="teto" data-min="' + t + '">' + t + '</button>';
    });
    h += '</div></section><section class="bloco"><h2 class="rotulo">Cópia de segurança</h2>';
    h += '<p class="meta-2">' + (n ? (E.copiaEm ? 'Última gerada: ' + haQuanto(E.copiaEm, agora) : 'Ainda não feita') + ' · ' + plural(n, 'resposta', 'respostas') + ' no histórico' : 'Ainda não há respostas para guardar') + '</p>';
    if (n) h += '<button class="btn" data-acao="copia">Guardar cópia</button>';
    h += '<button class="btn btn-2" data-acao="escolher">Restaurar de uma cópia</button><input type="file" id="arquivo" accept=".json,application/json,text/plain">';
    h += '<p class="recado" role="status">' + RV_esc(recado) + '</p></section>';
    h += '<p class="nota-rodape">O histórico fica só neste aparelho. A cópia é um arquivo: guarde em Arquivos ou no iCloud. É ela que permite recuperar tudo se o app for apagado.</p>';
    return '<main class="tela">' + h + '</main>';
  }

  // Confirmação só aqui: restaurar por cima de um histórico existente não tem volta.
  function telaConfirmar() {
    var h = '<header class="topo"><button class="icone-btn esq" data-acao="voltar" aria-label="Voltar">' + ICO.voltar + '</button><p class="conta"></p></header>';
    h += '<section class="fim"><h1 class="titulo">Restaurar cópia</h1>' +
      '<p class="meta">A cópia é de ' + (pendente.copiaEm ? dataCurta(pendente.copiaEm + 4 * 3600000) : 'data desconhecida') + ' e tem ' + plural(pendente.revisoes.length, 'resposta', 'respostas') + '.</p>' +
      '<p class="meta">O histórico deste aparelho, com ' + plural(E.revisoes.length, 'resposta', 'respostas') + ', será substituído. Não dá para desfazer.</p></section>';
    h += '<footer class="trilho solto"><button class="btn" data-acao="restaurar">Restaurar</button><button class="btn btn-2" data-acao="voltar">Cancelar</button></footer>';
    return '<main class="tela">' + h + '</main>';
  }

  function telaErro(titulo, texto, e) {
    tela = 'erro';
    app.innerHTML = '<main class="tela"><section class="fim"><h1 class="titulo">' + titulo + '</h1><div class="aviso"><p>' + texto + '</p>' +
      (e && e.message ? '<p><code>' + RV_esc(e.message) + '</code></p>' : '') + '</div></section></main>';
  }

  function RV_esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  var TELAS = { hoje: telaHoje, sessao: telaSessao, fim: telaFim, ajustes: telaAjustes, confirmar: telaConfirmar };

  function mostrar(t) {
    if (tela === 'erro') return;
    if ((t === 'sessao' || t === 'fim') && !sessao) t = 'hoje';
    if (t === 'confirmar' && !pendente) t = 'ajustes';
    if (t === 'hoje') sessao = null;
    if (t !== 'ajustes' && t !== 'confirmar') recado = '';
    tela = t;
    app.innerHTML = TELAS[t]();
    window.scrollTo(0, 0);
  }

  // Toda tela aberta entra no histórico do navegador: o voltar do celular fecha a tela, e os botões de fechar passam pelo mesmo caminho.
  function abrir(t) { history.pushState({ tela: t }, ''); mostrar(t); }
  function trocar(t) { history.replaceState({ tela: t }, ''); mostrar(t); }
  window.addEventListener('popstate', function (ev) { mostrar((ev.state && ev.state.tela) || 'hoje'); });

  /* ---------- sessão ---------- */
  function comecar(filtro) {
    var agora = Date.now();
    sessao = { filtro: filtro || null, feitas: 0, acertos: 0, ultimo: null, forcar: null, atual: null, restam: 0, respostas: 0, revelado: false,
      inicio: 0, reveladoEm: 0, fim: null, seg0: RV.gastoSeg(E, agora) };
    history.pushState({ tela: 'sessao' }, '');
    avancar();
  }

  function avancar() {
    var agora = Date.now(), p = RV.proximo(E, C, agora, sessao.filtro);
    if (sessao.forcar) { p = { id: sessao.forcar, restam: Math.max(1, p.restam || 0), respostas: Math.max(1, p.respostas || 0) }; sessao.forcar = null; }
    if (p.fim) { sessao.fim = p; return trocar('fim'); }
    sessao.fim = null; sessao.atual = p.id; sessao.restam = p.restam; sessao.respostas = p.respostas; sessao.revelado = false; sessao.inicio = agora;
    trocar('sessao');
  }

  function darNota(n) {
    var agora = Date.now();
    if (!sessao || !sessao.revelado || agora - sessao.reveladoEm < TRAVA_MS) return; // toque duplo no "Mostrar resposta" não vira nota
    var f = RV.responder(E, sessao.atual, n, agora, (agora - sessao.inicio) / 1000);
    sessao.feitas++; if (n === RV.ACERTEI) sessao.acertos++;
    sessao.ultimo = f;
    gravar(function () { return gravarResposta(f); });
    avancar();
  }

  function desfazerUltima() {
    var f = sessao && sessao.ultimo;
    if (!f) return;
    RV.desfazer(E, f);
    sessao.feitas--; if (f.revisao[2] === RV.ACERTEI) sessao.acertos--;
    sessao.ultimo = null; sessao.forcar = f.id;
    gravar(function () { return gravarDesfazer(f); });
    avancar();
  }

  /* ---------- cópia de segurança ---------- */
  function guardarCopia() {
    var agora = Date.now(), texto = RV.exportar(E, agora), nome = 'revisao-copia-' + RV.diaDe(agora) + '.json', arq = null;
    var feito = function () { E.copiaEm = agora; gravar(gravarMeta); recado = 'Cópia gerada, com ' + plural(E.revisoes.length, 'resposta', 'respostas') + '. Confira se o arquivo ficou salvo.'; mostrar(tela); };
    var baixar = function () {
      var a = document.createElement('a'), url = URL.createObjectURL(new Blob([texto], { type: 'application/json' }));
      a.href = url; a.download = nome; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
      feito();
    };
    try { arq = new File([texto], nome, { type: 'application/json' }); } catch (e) { arq = null; }
    if (arq && navigator.canShare && navigator.canShare({ files: [arq] }))
      navigator.share({ files: [arq] }).then(feito, function (e) { if (!e || e.name !== 'AbortError') baixar(); });
    else baixar();
  }

  function lerArquivo(arq) {
    var leitor = new FileReader();
    leitor.onerror = function () { recado = 'Não consegui ler o arquivo.'; mostrar('ajustes'); };
    leitor.onload = function () {
      try { pendente = RV.restaurar(String(leitor.result)); } catch (e) { pendente = null; recado = e.message; return mostrar('ajustes'); }
      if (E.revisoes.length) abrir('confirmar'); else aplicarRestauracao(false);
    };
    leitor.readAsText(arq);
  }

  function aplicarRestauracao(voltar) {
    var novo = pendente; pendente = null;
    gravar(function () { return substituirTudo(novo); }).then(function () {
      E = novo;
      recado = 'Cópia restaurada: ' + plural(E.revisoes.length, 'resposta', 'respostas') + '.';
      if (voltar) history.back(); else mostrar('ajustes');
    });
  }

  /* ---------- toques ---------- */
  app.addEventListener('click', function (ev) {
    var alvo = ev.target.closest('[data-acao]'); if (!alvo) return;
    var acao = alvo.getAttribute('data-acao'), agora = Date.now();
    if (acao === 'revisar') comecar(alvo.getAttribute('data-baralho'));
    else if (acao === 'mostrar') {
      if (agora - sessao.inicio < TRAVA_MS) return; // toque duplo na nota não revela o card seguinte
      sessao.revelado = true; sessao.reveladoEm = agora; mostrar('sessao');
    }
    else if (acao === 'nota') darNota(+alvo.getAttribute('data-nota'));
    else if (acao === 'desfazer') desfazerUltima();
    else if (acao === 'voltar') history.back();
    else if (acao === 'ajustes') abrir('ajustes');
    else if (acao === 'copia') guardarCopia();
    else if (acao === 'escolher') document.getElementById('arquivo').click();
    else if (acao === 'restaurar') aplicarRestauracao(true);
    else if (acao === 'teto') { E.ajustes.tetoMin = +alvo.getAttribute('data-min'); gravar(gravarMeta); mostrar('ajustes'); }
    else if (acao === 'mais') { RV.maisMinutos(E, agora, 5); gravar(gravarMeta); if (sessao) avancar(); else mostrar('hoje'); }
  });
  app.addEventListener('change', function (ev) { if (ev.target.id === 'arquivo' && ev.target.files[0]) lerArquivo(ev.target.files[0]); });
  // Ao voltar para o app (outro dia, por exemplo), a tela inicial se refaz.
  document.addEventListener('visibilitychange', function () { if (!document.hidden && tela === 'hoje' && E) mostrar('hoje'); });

  /* ---------- partida ---------- */
  var cards = fetch('cartoes.md', { cache: 'no-store' }).then(function (r) {
    if (!r.ok) throw new Error('resposta ' + r.status);
    return r.text();
  });
  Promise.all([
    cards.catch(function (e) { throw { onde: 'rede', e: e }; }),
    abrirBanco().then(carregar).catch(function (e) { throw { onde: 'banco', e: e }; })
  ]).then(function (v) {
    try { C = RV.lerCartoes(v[0]); } catch (e) { throw { onde: 'arquivo', e: e }; }
    E = v[1];
    history.replaceState({ tela: 'hoje' }, '');
    mostrar('hoje');
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  }).catch(function (x) {
    if (x.onde === 'arquivo') telaErro('Há um problema no arquivo de cards', 'O app não abre pela metade. Corrija a linha indicada e abra de novo.', x.e);
    else if (x.onde === 'rede') telaErro('Não consegui carregar os cards', 'Confira a internet e abra de novo.', x.e);
    else if (x.onde === 'banco') telaErro('Este navegador não deixou abrir o histórico', 'Sem lugar para guardar as respostas, o app não abre. Isso acontece em janela anônima.', x.e);
    else telaErro('O app não abriu', 'Algo inesperado aconteceu.', x);
  });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js');

  // Só para os testes de tela: deixa trocar o relógio e ler o estado. Não é usado pelo app.
  window.__revisao = { estado: function () { return E; }, cards: function () { return C; }, mostrar: mostrar, espera: function () { return fila; } };
})();
