'use strict';
const { app } = require('@azure/functions');
const { createApp } = require('../lib/app');

let core = null;
const getCore = () => core || (core = createApp());

app.http('db', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'db',
  handler: async (request, context) => {
    let body;
    try {
      const text = await request.text();
      if (text.length > 4000000) return { status: 413, jsonBody: { ok: false, code: 'invalid-argument', message: 'Anfrage zu gross.' } };
      body = JSON.parse(text);
    } catch (e) {
      return { status: 400, jsonBody: { ok: false, code: 'invalid-argument', message: 'Kein gueltiges JSON.' } };
    }
    // Der Token liegt in einem eigenen Header, weil Static Web Apps den
    // Authorization-Header selbst verwendet bzw. ersetzen kann.
    const token = String(request.headers.get('x-ps-token') || '').trim();
    const res = await getCore().handle(token, body);
    if (res.error) context.error('db', res.error && res.error.message);
    return { status: res.status, jsonBody: res.json, headers: { 'Cache-Control': 'no-store' } };
  }
});
