-- Stammdaten: Marken, Shops (identisch mit SHOPS im Frontend), Rollen, Berechtigungen.
-- Idempotent (INSERT IGNORE), damit erneutes Ausführen nichts doppelt anlegt.

INSERT IGNORE INTO brands (id, label) VALUES
  ('o2', 'o2'),
  ('telekom', 'Telekom / Fachhandel');

INSERT IGNORE INTO shops (id, brand_id, name, ort) VALUES
  ('aalen',               'o2', 'o2 Shop Aalen',               'Aalen'),
  ('crailsheim',          'o2', 'o2 Shop Crailsheim',          'Crailsheim'),
  ('schwaebisch-hall',    'o2', 'o2 Shop Schwäbisch Hall',     'Schwäbisch Hall'),
  ('freilassing',         'o2', 'o2 Shop Freilassing',         'Freilassing'),
  ('neuoetting',          'o2', 'o2 Shop Neuötting',           'Neuötting'),
  ('rosenheim',           'o2', 'o2 Shop Rosenheim',           'Rosenheim'),
  ('sindelfingen',        'o2', 'o2 Shop Sindelfingen',        'Sindelfingen'),
  ('stuttgart-vaihingen', 'o2', 'o2 Shop Stuttgart-Vaihingen', 'Stuttgart-Vaihingen'),
  ('traunreut',           'o2', 'o2 Shop Traunreut',           'Traunreut'),
  ('traunstein',          'o2', 'o2 Shop Traunstein',          'Traunstein'),
  ('waldkraiburg',        'o2', 'o2 Shop Waldkraiburg',        'Waldkraiburg'),
  ('wasserburg',          'o2', 'o2 Shop Wasserburg',          'Wasserburg');

INSERT IGNORE INTO roles (id, label, rank_level) VALUES
  ('super_admin',    'Hauptadministrator', 100),
  ('admin',          'Administrator',       80),
  ('filialbetreuer', 'Filialbetreuer',      60),
  ('shop_leiter',    'Shop-Leiter',         40),
  ('mitarbeiter',    'Mitarbeiter',         20),
  ('azubi',          'Auszubildende/r',     10);

INSERT IGNORE INTO permissions (id, description) VALUES
  ('consultation.use',      'Beratungen durchführen, Smart Scan, PDF'),
  ('offers.own_shop',       'Gespeicherte Angebote der eigenen Shops lesen/schreiben'),
  ('offers.all_shops',      'Gespeicherte Angebote aller Shops lesen'),
  ('analytics.write_own',   'Eigene Beratungen an die Statistik übertragen'),
  ('analytics.read_own',    'Eigene Statistik lesen'),
  ('analytics.read_shops',  'Statistik der zugeordneten Shops lesen'),
  ('analytics.read_all',    'Statistik aller Shops lesen'),
  ('analytics.delete_all',  'Gesamte Statistik löschen'),
  ('archive.search_shops',  'Archivsuche in zugeordneten Shops'),
  ('archive.search_all',    'Archivsuche in allen Shops'),
  ('archive.import',        'Archiv-Index importieren / Selbsttest'),
  ('news.manage',           'News-Ticker pflegen'),
  ('skip.manage',           'Skip-Limits verwalten'),
  ('settings.manage',       'Anwendungseinstellungen pflegen'),
  ('users.read',            'Benutzerliste lesen'),
  ('users.manage',          'Benutzer freigeben, sperren, Rollen und Shops zuordnen'),
  ('audit.read',            'Audit-Protokoll lesen'),
  ('system.migrate',        'Datenbankmigrationen über die Web-Oberfläche ausführen');

-- Auszubildende/r und Mitarbeiter: Beratung + eigene Daten
INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES
  ('azubi', 'consultation.use'), ('azubi', 'offers.own_shop'), ('azubi', 'analytics.write_own'), ('azubi', 'analytics.read_own'),
  ('mitarbeiter', 'consultation.use'), ('mitarbeiter', 'offers.own_shop'), ('mitarbeiter', 'analytics.write_own'),
  ('mitarbeiter', 'analytics.read_own'), ('mitarbeiter', 'archive.search_shops');

-- Shop-Leiter: zusätzlich Statistik der eigenen Shops
INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES
  ('shop_leiter', 'consultation.use'), ('shop_leiter', 'offers.own_shop'), ('shop_leiter', 'analytics.write_own'),
  ('shop_leiter', 'analytics.read_own'), ('shop_leiter', 'analytics.read_shops'), ('shop_leiter', 'archive.search_shops');

-- Filialbetreuer: wie Shop-Leiter, plus Benutzerliste lesen
INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES
  ('filialbetreuer', 'consultation.use'), ('filialbetreuer', 'offers.own_shop'), ('filialbetreuer', 'analytics.write_own'),
  ('filialbetreuer', 'analytics.read_own'), ('filialbetreuer', 'analytics.read_shops'), ('filialbetreuer', 'archive.search_shops'),
  ('filialbetreuer', 'users.read');

-- Administrator: alles außer Gesamt-Löschung und Web-Migrationen
INSERT IGNORE INTO role_permissions (role_id, permission_id)
  SELECT 'admin', id FROM permissions WHERE id NOT IN ('analytics.delete_all', 'system.migrate');

-- Hauptadministrator: alles
INSERT IGNORE INTO role_permissions (role_id, permission_id)
  SELECT 'super_admin', id FROM permissions;
