/**
 * Child process: load app with connect-pg-simple, validate a session cookie via /api/auth/me.
 * Exit 0 if authenticated, 1 otherwise.
 */
require('dotenv').config();

const http = require('http');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

async function main() {
  const cookie = process.env.SESSION_COOKIE;
  if (!cookie) {
    console.error('SESSION_COOKIE missing');
    process.exit(2);
  }

  const { assertSafeTestDatabase } = require('./testDbGuard');
  assertSafeTestDatabase();

  const { createApp } = require('../../src/app');
  const { getPool, closePool } = require('../../src/db/pool');

  const store = new pgSession({
    pool: getPool(),
    tableName: 'session',
    createTableIfMissing: false,
  });
  const app = createApp({ sessionStore: store });

  await new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/auth/me',
          method: 'GET',
          headers: { Cookie: cookie },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => {
            data += c;
          });
          res.on('end', () => {
            server.close(async () => {
              try {
                await closePool();
              } catch (_) {}
              if (res.statusCode === 200) {
                process.exit(0);
              } else {
                console.error('me status', res.statusCode, data);
                process.exit(1);
              }
            });
          });
        }
      );
      req.on('error', (err) => {
        server.close(() => reject(err));
      });
      req.end();
    });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(3);
});
