/*
 * Pencil Selling – Verwaltung (Benutzer, Rollen, Shops, News, Statistik, Protokoll).
 * Spricht ausschließlich die eigene HeTec-API an. Alle Rechte prüft der Server; diese Seite blendet nur aus.
 */
(function () {
  'use strict';
  var API = new URL('../api/v1/', location.href).href;
  var csrf = '', me = null, roles = [], allRoles = [], shops = [], users = [];
  function rankOf(id) { var r = allRoles.filter(function (x) { return x.id === id; })[0]; return r ? Number(r.rank_level) : 0; }
  function editable(u) { return can('users.manage') && u.id !== me.id && (me.role === 'super_admin' || rankOf(u.role) < rankOf(me.role)); }

  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function msg(text, ok) {
    var m = document.getElementById('msg');
    m.textContent = text;
    m.className = 'mb-4 rounded-lg p-3 text-sm ' + (ok ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800');
    clearTimeout(msg.t); msg.t = setTimeout(function () { m.className = 'hidden'; }, 5000);
  }
  function api(method, path, body) {
    var h = { Accept: 'application/json' };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (method !== 'GET') h['X-PS-CSRF'] = csrf;
    return fetch(API + path, { method: method, headers: h, credentials: 'same-origin', body: body !== undefined ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || ('HTTP ' + r.status)); e.status = r.status; throw e; } return j; }); });
  }
  var ERR = { insufficient_rank: 'Diese Änderung erfordert eine höhere Rolle.', cannot_modify_self: 'Eigene Rolle/Status kann nicht selbst geändert werden.', forbidden: 'Keine Berechtigung.', invalid_shop: 'Unbekannter Shop.' };
  function fail(e) { msg(ERR[e.message] || ('Fehler: ' + e.message), false); }
  var can = function (p) { return me && me.permissions.indexOf(p) !== -1; };

  // ── Benutzer ──
  function renderUsers() {
    var q = document.getElementById('q').value.trim().toLowerCase();
    var fs = document.getElementById('fstatus').value;
    var rows = users.filter(function (u) { return (!fs || u.status === fs) && (!q || (u.name + ' ' + u.email).toLowerCase().indexOf(q) !== -1); });
    var STATUS = { pending: 'Wartet', approved: 'Freigegeben', blocked: 'Gesperrt', rejected: 'Abgelehnt' };
    document.getElementById('users').innerHTML = rows.map(function (u) {
      var dis = editable(u) ? '' : ' disabled';
      var opts = editable(u) ? roles : allRoles;
      var roleSel = '<select class="mini" data-f="role" data-id="' + esc(u.id) + '"' + dis + '>' + opts.map(function (r) { return '<option value="' + esc(r.id) + '"' + (r.id === u.role ? ' selected' : '') + '>' + esc(r.label) + '</option>'; }).join('') + '</select>';
      var homeSel = '<select class="mini" data-f="homeShopId" data-id="' + esc(u.id) + '"' + dis + '><option value="">–</option>' + shops.map(function (s) { return '<option value="' + esc(s.id) + '"' + (s.id === u.homeShopId ? ' selected' : '') + '>' + esc(s.ort) + '</option>'; }).join('') + '</select>';
      var extra = '<div class="shops">' + shops.filter(function (s) { return s.id !== u.homeShopId; }).map(function (s) {
        return '<label><input type="checkbox" data-f="extra" data-id="' + esc(u.id) + '" value="' + esc(s.id) + '"' + (u.extraShopIds.indexOf(s.id) !== -1 ? ' checked' : '') + dis + '> ' + esc(s.ort) + '</label>';
      }).join('') + '</div>';
      var actions = '';
      if (editable(u)) {
        if (u.status !== 'approved') actions += '<button class="btn ok" data-act="approved" data-id="' + esc(u.id) + '">Freigeben</button> ';
        if (u.status === 'pending') actions += '<button class="btn no" data-act="rejected" data-id="' + esc(u.id) + '">Ablehnen</button> ';
        if (u.status === 'approved') actions += '<button class="btn no" data-act="blocked" data-id="' + esc(u.id) + '">Sperren</button> ';
        actions += '<button class="btn ghost" data-act="revoke" data-id="' + esc(u.id) + '" title="Alle Sitzungen beenden (z. B. verlorenes Tablet)">Abmelden</button>';
      }
      return '<tr class="border-t border-slate-100 align-top">' +
        '<td class="p-3"><div class="font-bold">' + esc(u.name || '–') + (u.isTestUser ? ' <span class="badge pending">Test</span>' : '') + '</div><div class="text-slate-500">' + esc(u.email) + '</div>' + (u.entraLinked ? '' : '<div class="text-xs text-amber-700">noch nicht mit Microsoft verknüpft</div>') + '</td>' +
        '<td class="p-3"><span class="badge ' + esc(u.status) + '">' + esc(STATUS[u.status] || u.status) + '</span></td>' +
        '<td class="p-3">' + roleSel + '</td><td class="p-3">' + homeSel + '</td><td class="p-3">' + extra + '</td>' +
        '<td class="p-3"><input type="checkbox" data-f="allShops" data-id="' + esc(u.id) + '"' + (u.allShops ? ' checked' : '') + dis + ' title="Springer: darf in allen Shops beraten"></td>' +
        '<td class="p-3 text-slate-500">' + esc(u.lastLoginAt ? u.lastLoginAt.slice(0, 16).replace('T', ' ') : '–') + '</td>' +
        '<td class="p-3 whitespace-nowrap">' + actions + '</td></tr>';
    }).join('') || '<tr><td class="p-4 text-slate-500" colspan="8">Keine Einträge</td></tr>';
  }
  function patchUser(id, body, label) {
    return api('PATCH', 'admin/users/' + encodeURIComponent(id), body).then(function (r) {
      users = users.map(function (u) { return u.id === id ? r.user : u; });
      renderUsers();
      msg(label || 'Gespeichert. Laufende Sitzungen dieses Benutzers wurden beendet, die neuen Rechte gelten ab der nächsten Anmeldung.', true);
    }, function (e) { fail(e); loadUsers(); });
  }
  document.getElementById('users').addEventListener('change', function (e) {
    var t = e.target, id = t.getAttribute('data-id'), f = t.getAttribute('data-f');
    if (!id || !f) return;
    if (f === 'extra') {
      var ids = Array.prototype.map.call(document.querySelectorAll('input[data-f="extra"][data-id="' + id + '"]:checked'), function (x) { return x.value; });
      patchUser(id, { extraShopIds: ids });
    } else if (f === 'allShops') {
      patchUser(id, { allShops: t.checked });
    } else {
      var b = {}; b[f] = t.value || null; patchUser(id, b);
    }
  });
  document.getElementById('users').addEventListener('click', function (e) {
    var t = e.target.closest('button[data-act]');
    if (!t) return;
    var id = t.getAttribute('data-id'), act = t.getAttribute('data-act');
    if (act === 'revoke') {
      api('POST', 'admin/users/' + encodeURIComponent(id) + '/revoke-sessions', {}).then(function (r) { msg(r.revoked + ' Sitzung(en) beendet.', true); }, fail);
      return;
    }
    if (act !== 'approved' && !confirm('Wirklich ' + (act === 'blocked' ? 'sperren' : 'ablehnen') + '?')) return;
    patchUser(id, { status: act }, act === 'approved' ? 'Freigegeben.' : 'Gespeichert – Sitzungen beendet.');
  });
  document.getElementById('q').addEventListener('input', renderUsers);
  document.getElementById('fstatus').addEventListener('change', renderUsers);
  function loadUsers() { return api('GET', 'admin/users').then(function (j) { users = j.users; renderUsers(); }, fail); }

  // ── Statistik ──
  function loadStats() {
    var g = document.getElementById('sgroup').value, f = document.getElementById('sfrom').value, t = document.getElementById('sto').value;
    api('GET', 'statistics/summary?groupBy=' + g + (f ? '&from=' + f : '') + (t ? '&to=' + t : '')).then(function (j) {
      var results = {};
      j.groups.forEach(function (x) { Object.keys(x.byResult).forEach(function (r) { results[r] = 1; }); });
      var cols = Object.keys(results).sort();
      document.getElementById('stats').innerHTML = '<thead class="bg-slate-50 text-left text-slate-500"><tr><th class="p-3">' + esc(g === 'shop' ? 'Shop' : g === 'user' ? 'Mitarbeiter' : 'Monat') + '</th><th class="p-3">Gesamt</th>' + cols.map(function (c) { return '<th class="p-3">' + esc(c) + '</th>'; }).join('') + '</tr></thead><tbody>' +
        j.groups.map(function (x) { return '<tr class="border-t border-slate-100"><td class="p-3 font-bold">' + esc(x.group || '–') + '</td><td class="p-3">' + x.total + '</td>' + cols.map(function (c) { return '<td class="p-3">' + (x.byResult[c] || 0) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody>';
    }, fail);
  }
  ['sgroup', 'sfrom', 'sto'].forEach(function (id) { document.getElementById(id).addEventListener('change', loadStats); });

  // ── News ──
  var news = [];
  function renderNews() {
    var list = news.concat([]);
    while (list.length < 5) list.push({ text: '', bis: '' });
    document.getElementById('news').innerHTML = list.slice(0, 5).map(function (n, i) {
      return '<div class="flex gap-2"><input data-n="' + i + '" data-k="text" maxlength="300" value="' + esc(n.text) + '" placeholder="Meldung ' + (i + 1) + '" class="flex-1 px-3 py-2 rounded-lg border border-slate-300 text-sm"><input type="date" data-n="' + i + '" data-k="bis" value="' + esc(n.bis) + '" class="px-3 py-2 rounded-lg border border-slate-300 text-sm" title="sichtbar bis (optional)"></div>';
    }).join('');
  }
  document.getElementById('news-save').addEventListener('click', function () {
    var items = [];
    for (var i = 0; i < 5; i++) {
      var t = document.querySelector('[data-n="' + i + '"][data-k="text"]').value.trim();
      var b = document.querySelector('[data-n="' + i + '"][data-k="bis"]').value;
      if (t) items.push({ text: t, bis: b });
    }
    api('PUT', 'news/o2', { items: items }).then(function (j) { news = j.items; renderNews(); msg('News gespeichert.', true); }, fail);
  });

  // ── Protokoll ──
  function loadAudit() {
    api('GET', 'admin/audit?limit=300').then(function (j) {
      document.getElementById('audit').innerHTML = '<thead class="bg-slate-50 text-left text-slate-500"><tr><th class="p-3">Zeit (UTC)</th><th class="p-3">Wer</th><th class="p-3">Aktion</th><th class="p-3">Objekt</th><th class="p-3">Details</th></tr></thead><tbody>' +
        j.entries.map(function (a) { return '<tr class="border-t border-slate-100"><td class="p-3 whitespace-nowrap">' + esc(String(a.ts).slice(0, 19)) + '</td><td class="p-3">' + esc(a.actor || 'System') + '</td><td class="p-3 font-semibold">' + esc(a.action) + '</td><td class="p-3">' + esc(a.entity + (a.entity_id ? ' ' + a.entity_id : '')) + '</td><td class="p-3 text-slate-500">' + esc(a.details ? JSON.stringify(a.details) : '') + '</td></tr>'; }).join('') + '</tbody>';
    }, fail);
  }

  // ── Navigation ──
  function show(tab) {
    Array.prototype.forEach.call(document.querySelectorAll('.view'), function (v) { v.classList.toggle('hidden', v.id !== 'view-' + tab); });
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === tab); });
    if (tab === 'stats') loadStats();
    if (tab === 'audit') loadAudit();
    if (tab === 'news') api('GET', 'news/o2').then(function (j) { news = j.items || []; renderNews(); }, fail);
  }
  document.getElementById('tabs').addEventListener('click', function (e) { var b = e.target.closest('[data-tab]'); if (b) show(b.getAttribute('data-tab')); });

  api('GET', 'session').then(function (s) {
    if (!s.authenticated) { location.href = API + 'auth/login?returnTo=' + encodeURIComponent(location.pathname); return; }
    me = s.user; csrf = s.csrfToken;
    document.getElementById('me').textContent = me.name + ' · ' + me.role;
    if (!can('users.read')) { document.querySelector('main').innerHTML = '<p class="text-slate-600">Keine Berechtigung für die Verwaltung.</p>'; return; }
    if (!can('news.manage')) document.querySelector('[data-tab="news"]').remove();
    if (!can('audit.read')) document.querySelector('[data-tab="audit"]').remove();
    return api('GET', 'admin/roles').then(function (r) {
      allRoles = r.roles;
      roles = r.roles.filter(function (x) { return me.role === 'super_admin' || x.rank_level < (r.roles.filter(function (y) { return y.id === me.role; })[0] || {}).rank_level; });
      if (!roles.length) roles = r.roles;
      shops = r.shops.filter(function (x) { return Number(x.active) === 1; });
      return loadUsers();
    }).then(function () { show('users'); });
  }, fail);
})();
