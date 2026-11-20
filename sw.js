/* Funciona sem internet: guarda o app na primeira visita. Com rede, busca primeiro a versão nova de tudo que é texto
   (cards, código, estilo). Trocar VERSAO a cada publicação, senão o celular pode mostrar a versão antiga. */
const VERSAO = 'revisao-v2';
const BASE = ['./', 'index.html', 'app.css', 'app.js', 'nucleo.js', 'lib/ts-fsrs.umd.js', 'cartoes.md', 'manifest.webmanifest',
  'icone-192.png', 'icone-512.png', 'icone-180.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSAO).then(c => c.addAll(BASE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSAO).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (/\.(png|webmanifest)$/.test(u.pathname)) {
    // ícones: cache primeiro
    e.respondWith(caches.match(e.request).then(m => m || fetch(e.request).then(r => {
      if (r.ok) { const c = r.clone(); caches.open(VERSAO).then(x => x.put(e.request, c)); }
      return r;
    })));
    return;
  }
  // rede primeiro (pega atualização), cache se estiver sem internet
  e.respondWith(fetch(e.request, { cache: 'no-store' }).then(r => {
    if (r.ok) { const c = r.clone(); caches.open(VERSAO).then(x => x.put(e.request, c)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
