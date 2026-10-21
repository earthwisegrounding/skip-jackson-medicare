'use strict';
// Files we create (database, WAL, backups, secrets) are private to this user.
process.umask(0o077);
// Consistent online backup of the CRM database using SQLite's VACUUM INTO.
//   npm run backup                 -> backups/crm-YYYYMMDD-HHMMSS.db
//   BACKUP_DIR=/mnt/backups npm run backup

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const root = path.join(__dirname, '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(root, 'backups'));
const src = path.join(dataDir, 'crm.db');

if (!fs.existsSync(src)) {
  console.error(`No database found at ${src}`);
  process.exit(1);
}
fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const dest = path.join(backupDir, `crm-${stamp}.db`);

const db = new DatabaseSync(src);
db.exec('PRAGMA busy_timeout = 10000');
db.prepare('VACUUM INTO ?').run(dest);
db.close();
fs.chmodSync(dest, 0o600); // already 0600 via umask; belt and braces

const check = new DatabaseSync(dest, { readOnly: true });
const ok = check.prepare('PRAGMA integrity_check').get();
const contacts = check.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
check.close();
console.log(`Backup written: ${dest} (${(fs.statSync(dest).size / 1024).toFixed(0)} KB, ${contacts} contacts, integrity ${Object.values(ok)[0]})`);
