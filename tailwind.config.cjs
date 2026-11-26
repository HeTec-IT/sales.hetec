/* Tailwind wird zur Build-Zeit erzeugt (vendor/tailwind/tailwind.css) statt zur Laufzeit vom CDN.
   Inhalt: alle Dateien, in denen Klassen vorkommen. Dynamisch zusammengesetzte Klassen gehören in die safelist. */
module.exports = {
  content: ['./index.html', './frontend/**/*.js', './admin/**/*.html', './admin/**/*.js'],
  safelist: [
    { pattern: /^(bg|text|border)-(slate|gray|red|green|blue|amber|orange|emerald|sky|indigo|violet|rose|yellow)-(50|100|200|300|400|500|600|700|800|900)$/ },
  ],
  theme: { extend: {} },
  corePlugins: { preflight: true },
  plugins: [],
};
