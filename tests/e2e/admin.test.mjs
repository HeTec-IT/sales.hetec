// Verwaltungsoberfläche (admin/): Freigabe eines wartenden Kontos, Shop-Zuordnung, Rechte serverseitig.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, phpAvailable } from '../backend/harness.mjs';
import { browsers } from './lib.mjs';

const skip = !phpAvailable() && 'PHP fehlt';
let env, list = [];
before(async () => { if (skip) return; env = await startEnv(); list = await browsers(['chromium']); });
after(async () => { for (const { b } of list) await b.close(); if (env) await env.stop(); });

async function devLogin(ctx, email) {
  const pg = await ctx.newPage({ viewport: { width: 1400, height: 900 } });
  pg.errs = [];
  pg.on('pageerror', e => pg.errs.push(String(e)));
  await pg.goto(env.app + '/');
  await pg.click(`button[data-email="${email}"]`);
  await pg.waitForSelector('header', { timeout: 30000 });
  return pg;
}

test('Admin gibt ein wartendes Konto frei und ordnet einen weiteren Shop zu', { skip, timeout: 120000 }, async t => {
  if (!list.length) return t.skip('kein Chromium');
  const ctx = await list[0].b.newContext();
  const pg = await devLogin(ctx, 'test.haupt.admin@hetec-gmbh.de');
  await pg.goto(env.app + '/admin/');
  await pg.waitForSelector('#users tr');
  const row = pg.locator('#users tr', { hasText: 'test.neu.wartend@hetec-gmbh.de' });
  await assert.doesNotReject(row.getByText('Wartet').waitFor());
  await row.getByRole('button', { name: 'Freigeben' }).click();
  await pg.waitForSelector('#msg:not(.hidden)');
  assert.equal(env.sql("SELECT status FROM users WHERE email = 'test.neu.wartend@hetec-gmbh.de'")[0].status, 'approved');
  await row.locator('input[data-f="extra"][value="rosenheim"]').check();
  await pg.waitForTimeout(800);
  const shops = env.sql("SELECT us.shop_id FROM user_shops us JOIN users u ON u.id = us.user_id WHERE u.email = 'test.neu.wartend@hetec-gmbh.de'").map(x => x.shop_id);
  assert.deepEqual(shops, ['rosenheim']);
  assert.deepEqual(pg.errs, []);
  await ctx.close();
});

test('Mitarbeiter ohne Verwaltungsrecht sieht keine Benutzerliste', { skip, timeout: 60000 }, async t => {
  if (!list.length) return t.skip('kein Chromium');
  const ctx = await list[0].b.newContext();
  const pg = await devLogin(ctx, 'test.max.verkauf@hetec-gmbh.de');
  await pg.goto(env.app + '/admin/');
  await pg.waitForSelector('text=Keine Berechtigung für die Verwaltung.');
  await ctx.close();
});
