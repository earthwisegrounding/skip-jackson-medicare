'use strict';
// Files we create (database, WAL, backups, secrets) are private to this user.
process.umask(0o077);
// Create (or reset the password of) a CRM user.
//
//   npm run create-user -- --email skip@example.com --name "Skip Jackson" --role admin
//   npm run create-user -- --email skip@example.com --reset        (new password for an existing user)
//   npm run create-user -- --email skip@example.com --reset --activate   (also re-activate a deactivated account)
//   printf '%s' "$PASSWORD" | npm run create-user -- --email … --name … --role admin --password-stdin
//
// The password is prompted for (hidden), read from stdin with --password-stdin (recommended for scripts:
// it doesn't end up in shell history or the process environment), or from CRM_PASSWORD as a fallback.

const path = require('node:path');
const readline = require('node:readline');
const { parseArgs } = require('node:util');
const { openDb } = require('../server/db');
const { hashPassword, passwordProblem } = require('../server/auth');
const { audit } = require('../server/services');

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) { reject(new Error('No terminal available. Set CRM_PASSWORD to run non-interactively.')); return; }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (s) => { if (!muted) rl.output.write(s); else if (s.includes('\n')) rl.output.write('\n'); };
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
    muted = true;
  });
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; if (data.length > 1000) reject(new Error('Password too long.')); });
    process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string', default: 'agent' },
      reset: { type: 'boolean', default: false }, activate: { type: 'boolean', default: false },
      'password-stdin': { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
    },
  });
  if (values.help || !values.email) {
    console.log('Usage: npm run create-user -- --email you@example.com --name "Your Name" --role admin|agent [--reset]');
    process.exit(values.help ? 0 : 1);
  }
  const email = values.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('That email address does not look right.');
  if (!['admin', 'agent'].includes(values.role)) throw new Error('--role must be admin or agent.');

  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
  const db = openDb(dataDir);
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (existing && !values.reset) throw new Error('A user with that email already exists. Use --reset to set a new password.');
  if (!existing && values.reset) throw new Error('No user with that email exists.');
  if (!existing && !values.name) throw new Error('--name is required for a new user.');

  let password = values['password-stdin'] ? await readStdin() : process.env.CRM_PASSWORD;
  if (!password) {
    password = await promptHidden('Password (at least 12 characters): ');
    const again = await promptHidden('Repeat password: ');
    if (password !== again) throw new Error('The passwords did not match.');
  }
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);

  const hash = await hashPassword(password);
  const now = new Date().toISOString();
  if (existing) {
    db.prepare('UPDATE users SET password_hash = ?, failed_attempts = 0, failed_window_start = NULL, locked_until = NULL, password_changed_at = ?, updated_at = ? WHERE id = ?').run(hash, now, now, existing.id);
    db.prepare('DELETE FROM login_throttle WHERE user_id = ?').run(existing.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
    audit(db, { action: 'password_reset', entity: 'user', entityId: existing.id, summary: 'via command line' });
    if (values.activate && !existing.active) {
      db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(existing.id);
      audit(db, { action: 'reactivate', entity: 'user', entityId: existing.id, summary: 'via command line' });
    }
    const active = values.activate || existing.active;
    console.log(`Password reset for ${email}. The account is unlocked${active ? ' and active' : ' but still DEACTIVATED (add --activate to re-enable it)'}.`);
  } else {
    const info = db.prepare('INSERT INTO users (name, email, role, password_hash, active, created_at, updated_at, password_changed_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)')
      .run(values.name.trim().slice(0, 80), email, values.role, hash, now, now, now);
    audit(db, { action: 'create', entity: 'user', entityId: Number(info.lastInsertRowid), summary: `role=${values.role}; via command line` });
    console.log(`Created ${values.role} ${email}. Sign in at /crm/`);
  }
  db.close();
}

main().catch((err) => { console.error(`Error: ${err.message}`); process.exit(1); });
