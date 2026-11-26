/*
 * Selbst gehostete Bibliotheken (vendor/, siehe vendor/manifest.json). Keine CDNs zur Laufzeit.
 * Absolute URLs, weil Web Worker relative Pfade sonst relativ zum Worker auflösen.
 */
(function () {
  'use strict';
  var abs = function (p) { return new URL(p, document.baseURI).href; };
  window.PS_VENDOR = Object.freeze({
    tesseractScript: abs('vendor/tesseract/tesseract.min.js'),
    pdfWorker: abs('vendor/pdfjs/pdf.worker.min.js'),
    // Optionen für Tesseract.createWorker: Worker, WASM-Kern und Sprachdaten von der eigenen Domain
    tesseractOptions: function (extra) {
      var o = {
        workerPath: abs('vendor/tesseract/worker.min.js'),
        corePath: abs('vendor/tesseract/core/'),
        langPath: abs('vendor/tesseract/lang'),
        gzip: true,
        cacheMethod: 'refresh'
      };
      if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
      return o;
    }
  });
})();
