/*
 * QR-Codes lokal erzeugen (statt api.qrserver.com). Kein Netzwerkzugriff, keine Daten an Dritte.
 * Nutzt vendor/qrcode.js (qrcode-generator, MIT). Ergebnis: PNG-Data-URL, synchron.
 */
(function () {
  'use strict';
  var cache = {};
  window.psQrDataUrl = function (text, size, hexColor) {
    text = String(text == null ? '' : text);
    size = Math.max(64, Math.min(1024, Number(size) || 200));
    var color = /^[0-9a-f]{6}$/i.test(String(hexColor || '')) ? '#' + hexColor : '#000000';
    var key = size + '|' + color + '|' + text;
    if (cache[key]) return cache[key];
    if (typeof window.qrcode !== 'function') return '';
    var qr;
    try { qr = window.qrcode(0, 'M'); qr.addData(text, 'Byte'); qr.make(); }
    catch (e) { qr = window.qrcode(0, 'L'); qr.addData(text, 'Byte'); qr.make(); }
    var n = qr.getModuleCount(), margin = 1, cells = n + margin * 2;
    var cell = Math.max(1, Math.floor(size / cells));
    var px = cell * cells;
    var c = document.createElement('canvas');
    c.width = c.height = px;
    var g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, px, px);
    g.fillStyle = color;
    for (var r = 0; r < n; r++) for (var col = 0; col < n; col++) if (qr.isDark(r, col)) g.fillRect((col + margin) * cell, (r + margin) * cell, cell, cell);
    var url = c.toDataURL('image/png');
    cache[key] = url;
    return url;
  };
})();
