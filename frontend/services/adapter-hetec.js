/*
 * ════════════════════════════════════════════════════════════════════════════
 *  HETEC-ADAPTER – Pencil Selling ↔ eigenes HeTec-Backend (PHP-API, MariaDB)
 * ════════════════════════════════════════════════════════════════════════════
 *  - Anmeldung ausschließlich über Microsoft Entra ID (Weiterleitung, serverseitige Sitzung, HttpOnly-Cookie).
 *  - Kein Google, kein Firebase, keine externen Analytics.
 *  - Statistikzeilen gehen über die IndexedDB-Warteschlange (PSSyncQueue) → offline-fest,
 *    ohne Doppelzählung (Server arbeitet idempotent mit der Zeilen-ID).
 *  - Zeitlich begrenzter Offline-Betrieb: Das zuletzt vom Server bestätigte Profil gilt höchstens
 *    offlineGraceHours (Server-Vorgabe, Standard 12 h). Danach ist eine Online-Anmeldung nötig.
 *    Offline wird nie die zentrale Rechteprüfung ersetzt: Jede Übertragung prüft der Server erneut.
 * ════════════════════════════════════════════════════════════════════════════
 */
(function () {
  'use strict';
  var cfg = window.PS_CONFIG || {};
  if (cfg.backend !== 'hetec') return;

  var BASE = new URL(String(cfg.apiBase || 'api/v1').replace(/\/?$/, '/'), document.baseURI).href;
  var SESSION_KEY = 'session';
  var state = { csrf: '', user: null, offline: false, ready: true, flushing: null };

  function err(code, status, extra) {
    var e = new Error(code);
    e.code = code;
    e.status = status || 0;
    if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
    return e;
  }
  // HTTP → bisherige Fehlercodes (wie Firestore), damit die vorhandene Fehlerbehandlung weiter passt
  function codeFor(status, body) {
    if (status === 401) return 'unauthenticated';
    if (status === 403) return 'permission-denied';
    if (status === 404) return 'not-found';
    if (status === 409) return 'aborted';
    if (status === 413) return (body && body.error === 'too_big') ? 'too-big' : 'resource-exhausted';
    if (status === 429) return 'resource-exhausted';
    if (status >= 500) return 'unavailable';
    return (body && body.error) || 'invalid-argument';
  }

  function api(method, path, body, opts) {
    opts = opts || {};
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timeout = opts.timeout || 15000;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, timeout) : null;
    var headers = { 'Accept': 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && state.csrf) headers['X-PS-CSRF'] = state.csrf;
    return fetch(BASE + path, {
      method: method, headers: headers, credentials: 'same-origin', cache: 'no-store',
      body: body !== undefined ? JSON.stringify(body) : undefined, signal: ctl ? ctl.signal : undefined
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      return res.text().then(function (t) {
        var j = null;
        try { j = t ? JSON.parse(t) : null; } catch (e) {}
        if (!res.ok) {
          if (res.status === 401) onAuthLost();
          throw err(codeFor(res.status, j), res.status, { body: j });
        }
        return j || {};
      });
    }, function (e) {
      if (timer) clearTimeout(timer);
      throw err(e && e.name === 'AbortError' ? 'deadline-exceeded' : 'unavailable', 0);
    });
  }

  var authLostNotified = false;
  function onAuthLost() {
    if (authLostNotified || !window.__PS_APP_STARTED) return;
    authLostNotified = true;
    try { window.dispatchEvent(new CustomEvent('ps-auth-lost')); } catch (e) {}
  }

  // ─────────────────────────── Anmeldeoberfläche ───────────────────────────
  function render(html) { var el = document.getElementById('root'); if (el) el.innerHTML = html; }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function card(inner) {
    return '<div class="ps-gate" style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f1f5f9;padding:16px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif">' +
      '<div style="width:100%;max-width:380px;background:#fff;border-radius:16px;box-shadow:0 10px 30px rgba(15,23,42,.12);padding:24px">' + inner + '</div></div>';
  }
  function spinner(text) {
    return '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#000068;padding:20px;font-family:system-ui,sans-serif"><div style="text-align:center;color:white">' +
      '<div style="width:42px;height:42px;border:4px solid rgba(255,255,255,.2);border-top-color:#3DE0FF;border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 14px"></div>' +
      '<div style="font-size:14px;font-weight:800;color:#3DE0FF">' + esc(text) + '</div></div></div>';
  }
  function returnTo() {
    var u = new URL(location.href);
    ['login', 'reason'].forEach(function (k) { u.searchParams.delete(k); });
    return u.pathname + u.search;
  }
  var REASONS = {
    wrong_tenant: 'Dieses Microsoft-Konto gehört nicht zur HeTec GmbH.',
    guest_not_allowed: 'Gastkonten sind für Pencil Selling nicht zugelassen.',
    domain_not_allowed: 'Nur Konten mit @hetec-gmbh.de sind zugelassen.',
    invalid_identity: 'Die Anmeldung konnte nicht eindeutig zugeordnet werden.'
  };
  function renderLogin(message, isError) {
    var btn = 'display:flex;align-items:center;justify-content:center;gap:10px;width:100%;border:0;border-radius:10px;padding:12px 16px;font-weight:700;font-size:15px;cursor:pointer;';
    render(card(
      '<h1 style="font-size:20px;font-weight:800;color:#0f172a;margin:0 0 4px">Pencil Selling</h1>' +
      '<p style="font-size:13px;color:#64748b;margin:0 0 18px">Anmeldung mit Ihrem HeTec-Microsoft-Konto</p>' +
      (message ? '<div id="ps-gate-msg" style="font-size:13px;border-radius:8px;padding:9px 10px;margin-bottom:14px;' + (isError ? 'color:#b91c1c;background:#fef2f2' : 'color:#1e3a8a;background:#eff6ff') + '">' + esc(message) + '</div>' : '') +
      '<button id="ps-ms-login" type="button" style="' + btn + 'background:#2f2f2f;color:#fff">' +
      '<svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>' +
      'Mit Microsoft anmelden</button>' +
      '<div id="ps-dev-login"></div>'
    ));
    document.getElementById('ps-ms-login').onclick = function () {
      this.disabled = true;
      this.textContent = 'Weiterleitung zu Microsoft …';
      location.href = BASE + 'auth/login?returnTo=' + encodeURIComponent(returnTo());
    };
    // Nur lokale Entwicklung: Test-Anmeldung (der Server bietet den Endpunkt in Produktion nicht an)
    if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
      api('GET', 'dev/users', undefined, { timeout: 3000 }).then(function (j) {
        var box = document.getElementById('ps-dev-login');
        if (!box || !j || !j.users) return;
        box.innerHTML = '<div style="margin-top:18px;border-top:1px dashed #cbd5e1;padding-top:12px"><div style="font-size:11px;font-weight:800;color:#b45309;margin-bottom:6px">TEST-ANMELDUNG (nur lokal, synthetische Konten)</div>' +
          j.users.map(function (u) { return '<button type="button" data-email="' + esc(u.email) + '" style="display:block;width:100%;text-align:left;border:1px solid #e2e8f0;background:#fff;border-radius:8px;padding:6px 9px;margin-bottom:5px;font-size:12px;cursor:pointer">' + esc(u.display_name) + ' <span style="color:#64748b">· ' + esc(u.role_id) + ' · ' + esc(u.status) + '</span></button>'; }).join('') + '</div>';
        Array.prototype.forEach.call(box.querySelectorAll('button[data-email]'), function (b) {
          b.onclick = function () {
            api('POST', 'dev/login', { email: b.getAttribute('data-email'), returnTo: returnTo() }).then(function (r) { location.href = r.redirect; });
          };
        });
      }).catch(function () {});
    }
  }
  function renderWait(name) {
    render(card('<h1 style="font-size:20px;font-weight:800;color:#0f172a;margin:0 0 8px">Warte auf Freigabe</h1>' +
      '<p style="font-size:14px;color:#475569;margin:0 0 16px">' + (name ? 'Hallo ' + esc(name) + ', d' : 'D') + 'ie Anmeldung bei Microsoft war erfolgreich. Ihr Zugang zu Pencil Selling muss noch durch einen Administrator freigegeben werden.</p>' +
      '<button id="ps-gate-retry" type="button" style="width:100%;border:0;border-radius:10px;padding:11px;background:#2563eb;color:#fff;font-weight:700;cursor:pointer">Erneut prüfen</button>' +
      '<button id="ps-gate-other" type="button" style="width:100%;border:0;background:transparent;color:#64748b;font-size:12px;padding:10px;cursor:pointer">Mit anderem Konto anmelden</button>'));
    document.getElementById('ps-gate-retry').onclick = function () { location.reload(); };
    document.getElementById('ps-gate-other').onclick = function () { signOutEverywhere(); };
  }
  function renderNameForm(startFn) {
    render(card('<h1 style="font-size:20px;font-weight:800;color:#0f172a;margin:0 0 4px">Profil vervollständigen</h1>' +
      '<p style="font-size:13px;color:#64748b;margin:0 0 14px">Einmalig – Ihr Name fehlt noch.</p>' +
      '<div id="ps-gate-msg" style="display:none;font-size:13px;color:#b91c1c;background:#fef2f2;border-radius:8px;padding:8px;margin-bottom:10px"></div>' +
      '<input id="ps-gate-vorname" placeholder="Vorname (optional)" style="width:100%;margin-bottom:8px;padding:9px 11px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px">' +
      '<input id="ps-gate-nachname" placeholder="Nachname" style="width:100%;margin-bottom:14px;padding:9px 11px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px">' +
      '<button id="ps-gate-submit" type="button" style="width:100%;border:0;border-radius:10px;padding:11px;background:#2563eb;color:#fff;font-weight:700;cursor:pointer">Speichern</button>'));
    document.getElementById('ps-gate-submit').onclick = function () {
      var vn = document.getElementById('ps-gate-vorname').value.trim(), nn = document.getElementById('ps-gate-nachname').value.trim();
      var msg = document.getElementById('ps-gate-msg');
      if (!nn) { msg.style.display = 'block'; msg.textContent = 'Bitte mindestens den Nachnamen ausfüllen.'; return; }
      api('PATCH', 'me/profile', { vorname: vn, nachname: nn }).then(function () { location.reload(); }, function () { msg.style.display = 'block'; msg.textContent = 'Speichern fehlgeschlagen – bitte erneut versuchen.'; });
    };
  }

  // ─────────────────────────── Sitzung / Offline ───────────────────────────
  function cacheSession(s) {
    return PSSyncQueue.kvSet(SESSION_KEY, { user: s.user, csrf: s.csrfToken, at: Date.now(), graceHours: s.offlineGraceHours || 0 }).catch(function () {});
  }
  function cachedSession() {
    return PSSyncQueue.kvGet(SESSION_KEY).then(function (c) {
      if (!c || !c.user || !c.at) return null;
      var max = Math.max(0, Number(c.graceHours) || 0) * 3600 * 1000;
      if (Date.now() - c.at > max) return null;
      return c;
    }).catch(function () { return null; });
  }
  function applyUser(user) {
    state.user = user;
    var access = window.PSAccess.sync(user, typeof SHOPS !== 'undefined' ? SHOPS : {});
    try {
      window.__PS_IS_ADMIN = access.isAdmin;
      window.__PS_USER_UID = user.id;
      window.__PS_PROFILE_NAME = user.name || '';
      window.__PS_PERMISSIONS = (user.permissions || []).slice();
      localStorage.setItem('ps_link_agent', user.name || '');
    } catch (e) {}
    return access;
  }
  function signOutEverywhere() {
    return api('POST', 'auth/logout', {}).then(function (r) { return r && r.logoutUrl; }, function () { return null; }).then(function (url) {
      return PSSyncQueue.kvDelete(SESSION_KEY).catch(function () {}).then(function () {
        try { if (window.__psClearActiveSession) window.__psClearActiveSession(); } catch (e) {}
        try { ['ps_link_agent', 'ps_allowed_shops', 'ps_shopwechsel'].forEach(function (k) { localStorage.removeItem(k); }); } catch (e) {}
        window.__psIntentionalReload = true;
        location.href = url || location.pathname;
      });
    });
  }

  function startGate(startAppFn) {
    render(spinner('Anmeldung wird geprüft …'));
    var params = new URLSearchParams(location.search);
    var loginResult = params.get('login');
    var reason = params.get('reason');
    if (loginResult) {
      try { var u = new URL(location.href); u.searchParams.delete('login'); u.searchParams.delete('reason'); history.replaceState(null, '', u.pathname + u.search + u.hash); } catch (e) {}
    }
    var started = false;
    function start(user, offline) {
      if (started) return;
      var access = applyUser(user);
      if (typeof CURRENT_SHOP_ID !== 'undefined' && access.effectiveShop !== CURRENT_SHOP_ID) {
        try {
          var u = new URL(location.href);
          u.searchParams.delete('shop');
          u.searchParams.delete('filiale');
          window.__psIntentionalReload = true;
          location.replace(u.toString());
          return;
        } catch (e) {}
      }
      started = true;
      window.__PS_APP_STARTED = true;
      state.offline = !!offline;
      if (typeof __psAddFloatingLogout === 'function') __psAddFloatingLogout();
      startAppFn();
      scheduleFlush(1500);
      setInterval(revalidate, 5 * 60 * 1000);
      window.addEventListener('online', function () { state.offline = false; revalidate(); scheduleFlush(500, true); });
      document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') revalidate(); });
    }
    api('GET', 'session', undefined, { timeout: 8000 }).then(function (s) {
      if (s.authenticated) {
        state.csrf = s.csrfToken || '';
        return cachedSession().then(function (old) {
          if (old && old.user && old.user.id !== s.user.id) {
            // Benutzerwechsel auf dem Gerät: aktive Beratung des Vorgängers verwerfen
            try { if (window.__psClearActiveSession) window.__psClearActiveSession(); } catch (e) {}
          }
          cacheSession(s);
          if (s.user.needsName) return renderNameForm();
          start(s.user, false);
        });
      }
      PSSyncQueue.kvDelete(SESSION_KEY).catch(function () {});
      if (s.status === 'pending') return renderWait(s.name);
      if (loginResult === 'denied') return renderLogin(REASONS[reason] || 'Ihr Zugang ist gesperrt oder wurde nicht freigegeben. Bitte wenden Sie sich an einen Administrator.', true);
      if (loginResult === 'error') return renderLogin('Die Anmeldung ist fehlgeschlagen. Bitte erneut versuchen.', true);
      renderLogin('', false);
    }, function (e) {
      // Server nicht erreichbar → zeitlich begrenzter Offline-Start mit dem zuletzt bestätigten Profil
      cachedSession().then(function (c) {
        if (c) { state.csrf = c.csrf || ''; start(c.user, true); return; }
        render(card('<h1 style="font-size:18px;font-weight:800;color:#0f172a;margin:0 0 8px">Keine Verbindung</h1>' +
          '<p style="font-size:14px;color:#475569;margin:0 0 16px">Für die Anmeldung wird eine Internetverbindung benötigt. Ohne Verbindung kann Pencil Selling nur innerhalb von ' +
          '12 Stunden nach der letzten erfolgreichen Anmeldung genutzt werden.</p>' +
          '<button onclick="location.reload()" style="width:100%;border:0;border-radius:10px;padding:11px;background:#2563eb;color:#fff;font-weight:700;cursor:pointer">Erneut versuchen</button>'));
      });
    });
  }

  function revalidate() {
    return api('GET', 'session', undefined, { timeout: 8000 }).then(function (s) {
      if (!s.authenticated) {
        if (!window.__PS_APP_STARTED) return;
        // Zugang entzogen oder Sitzung abgelaufen → Anmeldung (laufende Beratung bleibt per Pause-Logik erhalten, max. 5 Min.)
        PSSyncQueue.kvDelete(SESSION_KEY).catch(function () {});
        try { window.dispatchEvent(new CustomEvent('ps-auth-lost')); } catch (e) {}
        return;
      }
      state.csrf = s.csrfToken || state.csrf;
      state.offline = false;
      cacheSession(s);
      var access = window.PSAccess.sync(s.user, typeof SHOPS !== 'undefined' ? SHOPS : {});
      try { window.__PS_IS_ADMIN = access.isAdmin; window.__PS_PROFILE_NAME = s.user.name || window.__PS_PROFILE_NAME; } catch (e) {}
      if (access.permissionsChanged || (typeof CURRENT_SHOP_ID !== 'undefined' && access.effectiveShop !== CURRENT_SHOP_ID)) {
        window.__psIntentionalReload = true;
        location.reload();
      }
    }, function () { /* offline: bis zum Ablauf der Offline-Frist weiterarbeiten */ });
  }

  window.addEventListener('ps-auth-lost', function () {
    if (window.__psAuthLostShown) return;
    window.__psAuthLostShown = true;
    try {
      var b = document.createElement('div');
      b.setAttribute('role', 'alert');
      b.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:99999;background:#7f1d1d;color:#fff;font:600 13px system-ui,sans-serif;padding:10px 14px;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.25);display:flex;gap:10px;align-items:center';
      b.innerHTML = '<span>Sitzung abgelaufen – Daten bleiben lokal gespeichert.</span>';
      var btn = document.createElement('button');
      btn.textContent = 'Neu anmelden';
      btn.style.cssText = 'border:0;border-radius:7px;background:#fff;color:#7f1d1d;font-weight:800;padding:6px 10px;cursor:pointer';
      btn.onclick = function () { try { document.dispatchEvent(new Event('ps-save-now')); } catch (e) {} location.href = BASE + 'auth/login?returnTo=' + encodeURIComponent(returnTo()); };
      b.appendChild(btn);
      document.body.appendChild(b);
    } catch (e) {}
  });

  // ─────────────────────────── Warteschlange (Statistik) ───────────────────────────
  var flushTimer = null;
  function scheduleFlush(ms, force) {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(function () { flush(force).catch(function () {}); }, ms || 0);
  }
  // force=true: Wartezeit (Backoff) ignorieren – bei wiederhergestellter Verbindung oder ausdrücklichem Senden
  function flush(force) {
    if (state.flushing) return state.flushing;
    var uid = state.user && state.user.id;
    if (!uid || state.offline && !navigator.onLine) return Promise.resolve(0);
    state.flushing = (async function () {
      var sent = 0;
      try {
        await PSSyncQueue.purgeOld();
        var items = (await PSSyncQueue.list('analytics', uid, 1000)).filter(function (x) { return force || !x.nextTry || x.nextTry <= Date.now(); });
        for (var i = 0; i < items.length; i += 200) {
          var chunk = items.slice(i, i + 200);
          var res;
          try {
            res = await api('POST', 'analytics/batch', { rows: chunk.map(function (x) { return x.item; }) }, { timeout: 20000 });
          } catch (e) {
            if (e.code === 'unauthenticated') break;
            await PSSyncQueue.markRetry('analytics', uid, chunk.map(function (x) { return x.id; }));
            break;
          }
          await PSSyncQueue.remove('analytics', uid, res.accepted || []);
          sent += (res.accepted || []).length;
          if (res.rejected && res.rejected.length) {
            var byId = {};
            chunk.forEach(function (x) { byId[x.id] = x.item; });
            await PSSyncQueue.reject('analytics', uid, res.rejected.map(function (r) { return { id: r.id, reason: r.reason, item: byId[r.id] }; }));
          }
        }
      } finally {
        state.flushing = null;
      }
      return sent;
    })();
    return state.flushing;
  }

  function toB64(blob) {
    return blob.arrayBuffer().then(function (ab) {
      var u = new Uint8Array(ab), bin = '';
      for (var i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
      return btoa(bin);
    });
  }

  var skipCache = null;
  function skipAgents() {
    return api('GET', 'skip/agents').then(function (j) { skipCache = j.agents || []; return skipCache; });
  }
  function agentId(name) {
    var p = skipCache ? Promise.resolve(skipCache) : skipAgents();
    return p.then(function (list) {
      var hit = list.filter(function (a) { return a.agent === name; });
      if (hit.length !== 1) throw err('not-found', 404);
      return hit[0].userId;
    });
  }

  var adapter = {
    mode: 'hetec',
    ready: function () { return Promise.resolve(true); },
    isReady: function () { return true; },
    auth: {
      startGate: startGate,
      signOut: signOutEverywhere,
      signOutAndReload: signOutEverywhere,
      currentUid: function () { return (state.user && state.user.id) || ''; },
      currentEmail: function () { return String((state.user && state.user.email) || '').toLowerCase(); },
      getIdToken: function () { return Promise.reject(err('unsupported')); },
      isSignedIn: function () { return !!state.user; },
      isOffline: function () { return state.offline; },
      can: function (perm) { return !!(state.user && (state.user.permissions || []).indexOf(perm) !== -1); },
      revalidate: revalidate,
      offlineMaxMs: 12 * 60 * 60 * 1000
    },
    news: {
      load: function (brand) { return api('GET', 'news/' + encodeURIComponent(brand || 'o2'), undefined, { timeout: 6000 }).then(function (j) { return j.items || []; }); },
      save: function (clean, brand) { return api('PUT', 'news/' + encodeURIComponent(brand || 'o2'), { items: clean }).then(function (j) { return j.items; }); }
    },
    offers: {
      save: function (meta, json) {
        return api('PUT', 'offers/' + encodeURIComponent(meta.id), {
          shopId: meta.shopId, payload: json, label: meta.label, kunde: meta.kunde, datum: meta.datum, ts: meta.ts, agent: meta.agent
        }, { timeout: 20000 });
      },
      list: function (o) {
        return api('GET', 'offers?shopId=' + encodeURIComponent(o.shopId)).then(function (j) {
          var list = (j.offers || []).map(function (x) { return { id: x.id, ts: x.ts, label: x.label, datum: x.datum, agent: x.agent, kunde: x.kunde, legacyWithoutShop: false }; });
          if (!o.isAdmin) return list;
          // Admin: zusätzlich alle übrigen Shops (wie bisher in der Liste sichtbar)
          return api('GET', 'offers').then(function (all) {
            var seen = {};
            list.forEach(function (x) { seen[x.id] = 1; });
            (all.offers || []).forEach(function (x) { if (!seen[x.id]) list.push({ id: x.id, ts: x.ts, label: x.label, datum: x.datum, agent: x.agent, kunde: x.kunde, legacyWithoutShop: false }); });
            return list;
          }, function () { return list; });
        });
      },
      load: function (id) { return api('GET', 'offers/' + encodeURIComponent(id)).then(function (j) { return j.payload ? JSON.parse(j.payload) : null; }, function (e) { if (e.code === 'not-found') return null; throw e; }); },
      remove: function (id) { return api('DELETE', 'offers/' + encodeURIComponent(id)).then(function () { return true; }); }
    },
    analytics: {
      // Einreihen statt direkt senden: offline-fest, wird sofort im Hintergrund übertragen.
      write: function (row) {
        var uid = state.user && state.user.id;
        if (!uid) return Promise.reject(err('unauthenticated'));
        return PSSyncQueue.put('analytics', uid, row).then(function () { scheduleFlush(300); return true; });
      },
      loadAll: async function () {
        var scope = adapter.auth.can('analytics.read_all') ? 'all' : (adapter.auth.can('analytics.read_shops') ? 'shops' : 'own');
        var rows = [], cursor = '';
        for (var guard = 0; guard < 200; guard++) {
          var j = await api('GET', 'analytics?scope=' + scope + '&limit=1000' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), undefined, { timeout: 30000 });
          rows.push.apply(rows, j.rows || []);
          if (!j.next) break;
          cursor = j.next;
        }
        return rows;
      },
      loadOwn: async function () {
        var rows = [], cursor = '';
        for (var guard = 0; guard < 100; guard++) {
          var j = await api('GET', 'analytics?scope=own&limit=1000' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), undefined, { timeout: 30000 });
          rows.push.apply(rows, j.rows || []);
          if (!j.next) break;
          cursor = j.next;
        }
        return rows;
      },
      clearAll: function () { return api('DELETE', 'analytics?confirm=ALLE-STATISTIKEN-LOESCHEN').then(function () { return true; }); },
      flush: function () { return flush(true); },
      pendingCount: function () { return PSSyncQueue.count(state.user && state.user.id); }
    },
    skip: {
      getCount: function () { return api('GET', 'skip/me', undefined, { timeout: 4000 }).then(function (j) { return j.count || 0; }, function () { return 0; }); },
      getLimit: function () { return api('GET', 'skip/me', undefined, { timeout: 4000 }).then(function (j) { return j.limit || 15; }, function () { return 15; }); },
      getExempt: function () { return api('GET', 'skip/me', undefined, { timeout: 4000 }).then(function (j) { return !!j.exempt; }, function () { return false; }); },
      increment: function () { return api('POST', 'skip/me/increment', {}, { timeout: 4000 }).catch(function () {}); },
      reset: function (agent) { return agentId(agent).then(function (id) { return api('PUT', 'skip/agents/' + id, { resetCount: true }); }); },
      setLimit: function (agent, n) { return agentId(agent).then(function (id) { return api('PUT', 'skip/agents/' + id, { limit: Math.max(0, n) }); }); },
      adminList: function (agents) {
        return skipAgents().then(function (list) {
          var out = {};
          list.forEach(function (a) { if (!agents || !agents.length || agents.indexOf(a.agent) !== -1) out[a.agent] = { count: a.count, limit: a.limit }; });
          (agents || []).forEach(function (n) { if (!out[n]) out[n] = { count: 0, limit: 15 }; });
          return out;
        });
      }
    },
    tools: {
      track: function (tool) { return api('POST', 'tool-usage', { tool: String(tool) }).catch(function () {}); }
    },
    pdfIndex: {
      available: function () { return !!(state.user); },
      write: function (id, entry) {
        var uid = state.user && state.user.id;
        if (!uid) return Promise.reject(err('unauthenticated'));
        return api('PUT', 'pdf-index/' + encodeURIComponent(id), entry, { timeout: 8000 });
      },
      mine: function (uid, shops, since) {
        return api('GET', 'pdf-index/mine?since=' + Number(since || 0)).then(function (j) {
          return [{ ok: true, items: (j.items || []).map(function (x) { return Object.assign({ docId: String(x.fileName || '').toLowerCase().replace(/[^a-z0-9._+\-]/g, '_').slice(0, 180) }, x); }) }];
        }, function (e) { return [{ ok: false, code: e.code }]; });
      },
      search: function (key, shop, limit) {
        return api('GET', 'pdf-index/search?key=' + encodeURIComponent(key) + (shop ? '&shopId=' + encodeURIComponent(shop) : '') + '&limit=' + (limit || 150)).then(function (j) {
          var items = (j.items || []).map(function (x) { return Object.assign({ docId: String(x.fileName || '').toLowerCase().replace(/[^a-z0-9._+\-]/g, '_').slice(0, 180) }, x); });
          return { size: j.limited ? (limit || 150) : items.length, items: items };
        });
      },
      probe: function (shop) { return api('GET', 'pdf-index/probe' + (shop ? '?shopId=' + encodeURIComponent(shop) : '')); },
      selftest: function (id, entry) {
        return api('PUT', 'pdf-index/' + encodeURIComponent(id), entry).then(function () {
          return api('DELETE', 'pdf-index/' + encodeURIComponent(id)).then(function (j) { return (j.deleted || 0) > 0; });
        });
      },
      importChunk: function (chunk) { return api('POST', 'pdf-index/import', { entries: chunk }, { timeout: 60000 }).then(function (j) { return j.neu || 0; }); }
    },
    archive: {
      // Archiv-Flow über das Backend (kein Token im Browser). Antwortformat wie bisher vom Flow.
      request: function (payload, timeoutMs) {
        return api('POST', 'archive/flow', { payload: payload }, { timeout: timeoutMs || 30000 });
      }
    },
    downloads: {
      upload: function (blob) {
        return toB64(blob).then(function (b64) {
          var shop = typeof CURRENT_SHOP !== 'undefined' && CURRENT_SHOP ? CURRENT_SHOP.id : '';
          return api('POST', 'downloads', { data: b64, shopId: shop }, { timeout: 60000 }).then(function (j) { return { url: j.url, ids: [j.id] }; });
        });
      },
      remove: function (ids) {
        return Promise.all((ids || []).map(function (id) { return api('DELETE', 'downloads/' + encodeURIComponent(id)).catch(function () {}); }));
      }
    },
    settings: {
      aktionsmappeBundles: function () {
        return api('GET', 'settings/aktionsmappe', undefined, { timeout: 6000 }).then(function (j) {
          var v = j.value;
          return v && Array.isArray(v.bundles) ? v.bundles : (Array.isArray(v) ? v : []);
        });
      }
    },
    _flush: flush
  };
  window.__PS_ADAPTERS = window.__PS_ADAPTERS || {};
  window.__PS_ADAPTERS.hetec = adapter;
})();
