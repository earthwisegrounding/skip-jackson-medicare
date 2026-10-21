'use strict';
// Files we create (database, WAL, backups, secrets) are private to this user.
process.umask(0o077);
// Entry point: `npm start`.

const { createApp } = require('./app');

const app = createApp();

app.listen().then((addr) => {
  app.log.info('listening', { port: addr.port, data_dir: app.cfg.dataDir });
  const users = app.db.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').get().n;
  if (!users) app.log.info('no_users', { hint: 'Create the first admin: npm run create-user -- --email you@example.com --name "Your Name" --role admin' });
}).catch((err) => {
  app.log.error('listen_failed', { err: err.message });
  process.exit(1);
});

let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  app.log.info('shutting_down', { signal });
  const force = setTimeout(() => process.exit(1), 10000);
  force.unref();
  app.close().then(() => process.exit(0), () => process.exit(1));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => app.log.error('unhandled_rejection', { err: err && err.message }));
