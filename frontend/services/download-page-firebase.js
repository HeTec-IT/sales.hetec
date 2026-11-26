/*
 * Kunden-Download (?dl=…) im FIREBASE-Betrieb (Migrationsadapter). Nicht im HeTec-Release enthalten.
 */
(function () {
  'use strict';
  var P = window.__PS_DL_PAGE;
  if (!P) return;
  var id = P.id, head = P.head, body = P.body, show = P.show, EXPIRED = P.EXPIRED, FAIL = P.FAIL;
  try {
    var script;
    {
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
