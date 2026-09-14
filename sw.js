/* 삿포로 여행 일정 — 서비스 워커
   앱 파일을 캐시해서 오프라인에서도 화면이 뜨게 합니다.
   index.html이나 config.js를 수정했는데 반영이 안 되면
   아래 CACHE 버전 숫자를 올려주세요. */

const CACHE = 'sapporo-trip-v1';
const ASSETS = [
  './',
  './index.html',
  './config.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate', e=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch', e=>{
  const url = new URL(e.request.url);
  // 외부 API(지도 타일, 동기화, AI)는 항상 네트워크로
  if(url.origin !== location.origin){ return; }
  // 앱 파일은 네트워크 우선, 실패하면 캐시
  e.respondWith(
    fetch(e.request)
      .then(res=>{
        const copy = res.clone();
        caches.open(CACHE).then(c=>c.put(e.request, copy));
        return res;
      })
      .catch(()=> caches.match(e.request).then(r=> r || caches.match('./index.html')))
  );
});
