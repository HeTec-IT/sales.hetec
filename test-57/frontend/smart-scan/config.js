/*
 * Smart Scan – config.js
 * Zentrale Schalter für die Angebotserkennung. Keine Logik.
 *
 *  neural        Neuronale OCR (PaddleOCR PP-OCRv6 tiny, ONNX Runtime Web) im Web Worker verwenden.
 *                false → nur Tesseract (z. B. auf sehr alten Geräten oder zur Fehlersuche).
 *  neuralWorker  Pfad des selbst gehosteten OCR-Workers (ocr/generated, versioniert über den Service Worker).
 *  totalBudgetMs Gesamtzeitbudget je Foto, wenn die neuronale OCR aktiv ist.
 *  monthlyMaxCents  Obergrenze für plausible monatliche Gesamtkosten (Cent). Höhere Werte gelten als Lesefehler
 *                (Zeilenversatz: Einmalsumme ins Monatsfeld gerutscht) und werden nicht übernommen.
 *
 * Alle OCR-Bibliotheken und Modelle liegen auf der eigenen Domain. Es gibt keinen Cloud-Dienst und
 * keinen versteckten Rückfall auf einen Cloud-Dienst.
 */
window.PS_SMART_SCAN = Object.freeze(Object.assign({
  neural: true,
  neuralWorker: './ocr/generated/smart-scan-worker.mjs',
  totalBudgetMs: 12000,
  monthlyMaxCents: 100000
}, window.PS_SMART_SCAN_OVERRIDE || {}));
