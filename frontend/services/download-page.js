/*
 * Kunden-Download per QR-Code (?dl=<32 Hex-Zeichen>), z. B. das ausgefüllte Formular zur Rufnummernmitnahme.
 * Läuft VOR der App: ersetzt die Seite durch eine schlanke Download-Ansicht.
 *   hetec:    Datei kommt von der eigenen API (/api/v1/downloads/<id>/file), 24 h gültig.
 *   firebase: bisheriger Abruf aus Firestore 'portierung_files' (Migrationsadapter).
 */
(function () {
  'use strict';
  try {
    var m = /[?&]dl=([a-f0-9]{32})(?:&|$)/.exec(location.search);
    if (!m) return;
    var id = m[1];
    var cfg = window.PS_CONFIG || {};
    var style = '<style>body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f0f6ff;color:#0b1e42;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}' +
      '.c{background:#fff;border-radius:18px;box-shadow:0 8px 30px rgba(0,30,90,.15);padding:28px 24px;max-width:420px;width:100%;text-align:center}' +
      'h1{font-size:20px;margin:0 0 6px}p{color:#475569;font-size:14px;margin:6px 0 18px}' +
      'a.b{display:block;background:#0b3ccf;color:#fff;text-decoration:none;font-weight:800;padding:16px;border-radius:12px;font-size:16px;margin:10px 0}a.s{background:#fff;color:#0b3ccf;border:2px solid #0b3ccf}' +
      'body>:not(.c):not(script){display:none!important}.e{color:#b91c1c;font-weight:700}.sp{width:36px;height:36px;border:4px solid #dbeafe;border-top-color:#0b3ccf;border-radius:50%;animation:r 1s linear infinite;margin:14px auto}@keyframes r{to{transform:rotate(360deg)}}</style>';
    var head = '<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Ihr Formular – Download</title>' + style + '</head>';
    var body = '<body><div class="c"><h1>Ihr ausgefülltes Formular</h1><p>Interne Rufnummernmitnahme</p><div id="o"><div class="sp"></div><p>Wird geladen …</p></div></div>';
    var EXPIRED = 'Dieser Link ist abgelaufen oder wurde gelöscht. Bitte lassen Sie sich den Code im Shop neu erstellen.';
    var FAIL = 'Laden nicht möglich. Bitte Internetverbindung prüfen und erneut versuchen.';
    var show = 'function show(blob){var url=URL.createObjectURL(blob);var o=document.getElementById("o");' +
      'o.innerHTML=\'<a class="b" href="\'+url+\'" download="Rufnummernmitnahme.pdf">⬇ PDF herunterladen</a><a class="b s" href="\'+url+\'" target="_blank" rel="noopener">👁 PDF ansehen</a><p>Der Link ist 24 Stunden gültig.</p>\';}' +
      'function err(t){document.getElementById("o").innerHTML=\'<p class="e">\'+t+"</p>"}';
    var script;
    if (cfg.backend === 'hetec') {
      var url = new URL(String(cfg.apiBase || 'api/v1').replace(/\/?$/, '/') + 'downloads/' + id + '/file', document.baseURI).href;
      script = '<script>' + show + '(async function(){try{var r=await fetch(' + JSON.stringify(url) + ',{credentials:"omit",cache:"no-store"});' +
        'if(r.status===404){return err(' + JSON.stringify(EXPIRED) + ')}if(!r.ok){return err(' + JSON.stringify(FAIL) + ')}show(await r.blob());}catch(e){err(' + JSON.stringify(FAIL) + ')}})();<\/script>';
    } else {
      var fb = { apiKey: "AIzaSyD0z1CX9vcdRQPtIo9pCjZ7Xs1h6dLl_8w", authDomain: "o2-pencil-selling.firebaseapp.com", projectId: "o2-pencil-selling", storageBucket: "o2-pencil-selling.firebasestorage.app", messagingSenderId: "347119579425", appId: "1:347119579425:web:afbb0b60fe6a266627ce60" };
      script = '<script src="https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js"><\/script>' +
        '<script src="https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore-compat.js"><\/script>' +
        '<script>' + show + '(async function(){' +
        'try{var app=firebase.initializeApp(' + JSON.stringify(fb) + ',"dl");var db=firebase.firestore(app);var id=' + JSON.stringify(id) + ';' +
        'var first=await db.collection("portierung_files").doc(id+"-0").get();if(!first.exists){return err(' + JSON.stringify(EXPIRED) + ')}' +
        'var f=first.data(),n=f.n||1,parts=[f.d];for(var i=1;i<n;i++){var s=await db.collection("portierung_files").doc(id+"-"+i).get();if(!s.exists){return err("Datei unvollständig – bitte Code neu erstellen lassen.")}parts.push(s.data().d)}' +
        'var bin=atob(parts.join(""));var u=new Uint8Array(bin.length);for(var k=0;k<bin.length;k++)u[k]=bin.charCodeAt(k);' +
        'show(new Blob([u],{type:"application/pdf"}));}catch(e){err(' + JSON.stringify(FAIL) + ')}})();<\/script>';
    }
    window.__PS_DL_MODE = true;
    document.open(); document.write(head + body + script + '</body></html>'); document.close();
  } catch (e) {}
})();
