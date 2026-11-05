'use strict';
const { app } = require('@azure/functions');
const { createApp } = require('../lib/app');

let core = null;
const getCore = () => core || (core = createApp());

// GET /api/health - zeigt nur, ob Tenant, Client, Gruppen und Speicher eingerichtet sind.
app.http('health', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'health',
  handler: async () => {
    const h = await getCore().health();
    return { status: h.ok ? 200 : 503, jsonBody: h, headers: { 'Cache-Control': 'no-store' } };
  }
});
