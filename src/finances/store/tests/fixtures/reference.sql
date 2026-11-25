PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE account (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  balance_minor INTEGER NOT NULL DEFAULT 0,
  balance_date TEXT NOT NULL,
  balance_set INTEGER NOT NULL DEFAULT 0,
  opening_balance_minor INTEGER NOT NULL DEFAULT 0,
  opening_balance_date TEXT,
  opening_balance_set INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT ''
);
INSERT INTO account VALUES('account-primary','Demo','EUR',0,'2026-11-25',0,0,NULL,0,'');
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'EUR',
  price_minor INTEGER,
  frequency TEXT NOT NULL DEFAULT 'monthly',
  start_date TEXT,
  billing_day INTEGER,
  next_billing_override TEXT,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  cancelled_at TEXT,
  plan TEXT,
  notes TEXT NOT NULL DEFAULT '',
  external_payment INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO subscriptions VALUES('seed-sub-1','Mobilidad urbana','Desplazamientos por la ciudad.','EUR',NULL,'monthly',NULL,NULL,NULL,NULL,'active',NULL,NULL,'',0,0,NULL,0,'2026-11-25T05:05:37.101Z','2026-11-25T05:05:37.101Z');
INSERT INTO subscriptions VALUES('seed-sub-2','CorreoSeguro Pro','Buzón privado con gestor de claves.','EUR',1899,'monthly','2026-04-23',23,NULL,NULL,'active',NULL,NULL,'',0,0,NULL,1,'2026-11-25T05:05:37.101Z','2026-11-25T05:05:37.101Z');
INSERT INTO subscriptions VALUES('seed-sub-3','Conversador IA','Chat de inteligencia artificial de pago.','EUR',2400,'monthly','2026-09-30',30,NULL,NULL,'active',NULL,NULL,'',0,0,NULL,2,'2026-11-25T05:05:37.101Z','2026-11-25T05:05:37.101Z');
INSERT INTO subscriptions VALUES('seed-sub-4','Asistentes Cloud Go','Plan de pago para un catálogo de asistentes.','USD',1200,'monthly','2026-10-08',8,NULL,'2026-11-25','active',NULL,NULL,'',0,0,NULL,3,'2026-11-25T05:05:37.101Z','2026-11-25T05:05:37.101Z');
INSERT INTO subscriptions VALUES('seed-sub-5','Web ejemplo.dev','Un sitio de ejemplo.','USD',1299,'annual','2026-03-21',21,NULL,NULL,'active',NULL,NULL,'',0,0,NULL,4,'2026-11-25T05:05:37.101Z','2026-11-25T05:05:37.101Z');
INSERT INTO subscriptions VALUES('seed-sub-6','Soporte de sobremesa','Soporte articulado de sobremesa.','EUR',1750,'monthly','2026-09-28',28,NULL,'2027-01-10','active',NULL,NULL,'',0,0,NULL,5,'2026-11-25T05:05:37.101Z','2026-11-25T05:05:37.101Z');
INSERT INTO subscriptions VALUES('seed-sub-7','Canciones en streaming','Reproducción de audio en línea.','EUR',1049,'monthly','2025-04-17',17,NULL,'2026-12-10','active',NULL,NULL,'',0,0,NULL,6,'2026-11-25T05:05:37.101Z','2026-11-25T05:05:37.101Z');
INSERT INTO subscriptions VALUES('seed-sub-8','Almacén Nube','Copia de seguridad en la nube.','USD',400,'monthly','2026-07-26',26,NULL,NULL,'active',NULL,NULL,'',0,0,NULL,7,'2026-11-25T05:05:37.101Z','2026-11-25T05:05:37.101Z');
INSERT INTO subscriptions VALUES('seed-sub-9','Nube 400 GB','Espacio compartido de 400 GB.','EUR',549,'monthly','2025-02-14',24,NULL,NULL,'active',NULL,NULL,'',0,0,NULL,8,'2026-11-25T05:05:37.101Z','2026-11-25T05:05:37.101Z');
INSERT INTO subscriptions VALUES('seed-sub-10','Seguridad Hogar','Protección para todos los dispositivos de casa.','EUR',4499,'annual','2022-10-10',10,NULL,NULL,'active',NULL,NULL,'',0,0,NULL,9,'2026-11-25T05:05:37.101Z','2026-11-25T05:05:37.101Z');
CREATE TABLE subscription_prices (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  price_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
INSERT INTO subscription_prices VALUES('seed-price-2','seed-sub-2',1899,'EUR','2026-04-23',NULL,'Importe inicial de ejemplo.','2026-11-25T05:05:37.101Z');
INSERT INTO subscription_prices VALUES('seed-price-3','seed-sub-3',2400,'EUR','2026-09-30',NULL,'Importe inicial de ejemplo.','2026-11-25T05:05:37.101Z');
INSERT INTO subscription_prices VALUES('seed-price-4','seed-sub-4',1200,'USD','2026-10-08',NULL,'Importe inicial de ejemplo.','2026-11-25T05:05:37.101Z');
INSERT INTO subscription_prices VALUES('seed-price-5','seed-sub-5',1299,'USD','2026-03-21',NULL,'Importe inicial de ejemplo.','2026-11-25T05:05:37.101Z');
INSERT INTO subscription_prices VALUES('seed-price-6','seed-sub-6',1750,'EUR','2026-09-28',NULL,'Importe inicial de ejemplo.','2026-11-25T05:05:37.101Z');
INSERT INTO subscription_prices VALUES('seed-price-7-1','seed-sub-7',949,'EUR','2025-04-17','2026-07-16','Importe inicial del plan.','2026-11-25T05:05:37.101Z');
INSERT INTO subscription_prices VALUES('seed-price-7-2','seed-sub-7',1049,'EUR','2026-07-17',NULL,'Importe tras la revisión de julio de 2026.','2026-11-25T05:05:37.101Z');
INSERT INTO subscription_prices VALUES('seed-price-8','seed-sub-8',400,'USD','2026-07-26',NULL,'Importe inicial de ejemplo.','2026-11-25T05:05:37.101Z');
INSERT INTO subscription_prices VALUES('seed-price-9-1','seed-sub-9',849,'EUR','2025-02-14','2026-05-23','Importe inicial del plan.','2026-11-25T05:05:37.101Z');
INSERT INTO subscription_prices VALUES('seed-price-9-2','seed-sub-9',549,'EUR','2026-05-24',NULL,'Importe tras la revisión de mayo de 2026.','2026-11-25T05:05:37.101Z');
INSERT INTO subscription_prices VALUES('seed-price-10','seed-sub-10',4499,'EUR','2022-10-10',NULL,'Importe inicial de ejemplo.','2026-11-25T05:05:37.101Z');
CREATE TABLE subscription_plans (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE subscription_billing_days (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  billing_day INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
INSERT INTO subscription_billing_days VALUES('seed-billing-2','seed-sub-2',23,'2026-04-23','Día fijado en el alta.','2026-11-25T05:05:37.101Z');
INSERT INTO subscription_billing_days VALUES('seed-billing-3','seed-sub-3',30,'2026-09-30','Día fijado en el alta.','2026-11-25T05:05:37.101Z');
INSERT INTO subscription_billing_days VALUES('seed-billing-4','seed-sub-4',8,'2026-10-08','Día fijado en el alta.','2026-11-25T05:05:37.101Z');
INSERT INTO subscription_billing_days VALUES('seed-billing-5','seed-sub-5',21,'2026-03-21','Día fijado en el alta.','2026-11-25T05:05:37.101Z');
INSERT INTO subscription_billing_days VALUES('seed-billing-6','seed-sub-6',28,'2026-09-28','Día fijado en el alta.','2026-11-25T05:05:37.101Z');
INSERT INTO subscription_billing_days VALUES('seed-billing-7','seed-sub-7',17,'2025-04-17','Día fijado en el alta.','2026-11-25T05:05:37.101Z');
INSERT INTO subscription_billing_days VALUES('seed-billing-8','seed-sub-8',26,'2026-07-26','Día fijado en el alta.','2026-11-25T05:05:37.101Z');
INSERT INTO subscription_billing_days VALUES('seed-billing-9','seed-sub-9',24,'2025-02-14','Día fijado en el alta.','2026-11-25T05:05:37.101Z');
INSERT INTO subscription_billing_days VALUES('seed-billing-10','seed-sub-10',10,'2022-10-10','Día fijado en el alta.','2026-11-25T05:05:37.101Z');
CREATE TABLE subscription_pauses (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE subscription_status_history (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  date TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
INSERT INTO subscription_status_history VALUES('seed-status-2','seed-sub-2','active','2026-04-23','Alta inicial.','2026-11-25T05:05:37.101Z');
INSERT INTO subscription_status_history VALUES('seed-status-3','seed-sub-3','active','2026-09-30','Alta inicial.','2026-11-25T05:05:37.101Z');
INSERT INTO subscription_status_history VALUES('seed-status-4','seed-sub-4','active','2026-10-08','Alta inicial.','2026-11-25T05:05:37.101Z');
INSERT INTO subscription_status_history VALUES('seed-status-5','seed-sub-5','active','2026-03-21','Alta inicial.','2026-11-25T05:05:37.101Z');
INSERT INTO subscription_status_history VALUES('seed-status-6','seed-sub-6','active','2026-09-28','Alta inicial.','2026-11-25T05:05:37.101Z');
INSERT INTO subscription_status_history VALUES('seed-status-7','seed-sub-7','active','2025-04-17','Alta inicial.','2026-11-25T05:05:37.101Z');
INSERT INTO subscription_status_history VALUES('seed-status-8','seed-sub-8','active','2026-07-26','Alta inicial.','2026-11-25T05:05:37.101Z');
INSERT INTO subscription_status_history VALUES('seed-status-9','seed-sub-9','active','2025-02-14','Alta inicial.','2026-11-25T05:05:37.101Z');
INSERT INTO subscription_status_history VALUES('seed-status-10','seed-sub-10','active','2022-10-10','Alta inicial.','2026-11-25T05:05:37.101Z');
CREATE TABLE incomes (
  id TEXT PRIMARY KEY,
  concept TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  date TEXT NOT NULL,
  time TEXT,
  frequency TEXT NOT NULL DEFAULT 'once',
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'expected',
  paused INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  actual_amount_minor INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  concept TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Otros',
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  date TEXT NOT NULL,
  time TEXT,
  frequency TEXT NOT NULL DEFAULT 'once',
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  notes TEXT NOT NULL DEFAULT '',
  actual_amount_minor INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE subscription_charges (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  charge_date TEXT NOT NULL,
  time TEXT,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  rate_scaled INTEGER,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE exchange_rates (
  id TEXT PRIMARY KEY,
  from_currency TEXT NOT NULL,
  to_currency TEXT NOT NULL,
  rate_scaled INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
INSERT INTO exchange_rates VALUES('seed-rate-eur-usd','EUR','USD',1100000,'2026-11-01','Ejemplo','Tipo de cambio de ejemplo (1 EUR = 1,10 USD). No es el valor real.','2026-11-25T05:05:37.101Z');
INSERT INTO exchange_rates VALUES('seed-rate-usd-eur','USD','EUR',909091,'2026-11-01','Ejemplo','Tipo de cambio de ejemplo (1 EUR = 1,10 USD). No es el valor real.','2026-11-25T05:05:37.101Z');
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings VALUES('mainCurrency','EUR');
INSERT INTO settings VALUES('referenceRateNote','Tipo de cambio de ejemplo (1 EUR = 1,10 USD). No es el valor real.');
INSERT INTO settings VALUES('lastBackupAt','');
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_prices_sub ON subscription_prices(subscription_id, effective_from);
CREATE INDEX idx_pauses_sub ON subscription_pauses(subscription_id, start_date);
CREATE INDEX idx_billing_days_sub ON subscription_billing_days(subscription_id, effective_from);
CREATE INDEX idx_status_sub ON subscription_status_history(subscription_id, date);
CREATE INDEX idx_incomes_date ON incomes(date);
CREATE INDEX idx_expenses_date ON expenses(date);
CREATE INDEX idx_rates_pair ON exchange_rates(from_currency, to_currency, effective_from);
CREATE INDEX idx_charges_sub ON subscription_charges(subscription_id, charge_date);
COMMIT;
