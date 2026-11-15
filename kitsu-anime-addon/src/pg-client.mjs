// Minimal, dependency-free PostgreSQL client for Kitsu Anime Shelf 2.0.
//
// Implements the parts of the PostgreSQL v3 wire protocol the service needs:
// TLS negotiation (libpq sslmode semantics), SCRAM-SHA-256 / MD5 / cleartext
// (TLS only) authentication, parameterised extended-protocol queries, simple
// multi-statement queries for migrations, a bounded connection pool and
// transactions. The exported pool exposes the pg-compatible `query(text,
// values)` interface, so the `pg` package can replace it without other
// changes.
import net from 'node:net';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

const SSL_REQUEST_CODE = 80877103;
const PROTOCOL_VERSION = 196608;

export class PgError extends Error {
  constructor(fields) {
    super(fields.M || 'PostgreSQL error');
    this.name = 'PgError';
    this.code = fields.C;
    this.severity = fields.S;
    this.detail = fields.D;
    this.constraint = fields.n;
    this.table = fields.t;
    this.column = fields.c;
  }
}

export function parseConnectionString(value) {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new TypeError('DATABASE_URL must be a postgres:// URL');
  const params = url.searchParams;
  const sslmode = params.get('sslmode') || (['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname) ? 'prefer' : 'verify-full');
  if (!['disable', 'prefer', 'require', 'verify-ca', 'verify-full'].includes(sslmode)) throw new TypeError(`Unsupported sslmode ${sslmode}`);
  const sslrootcert = params.get('sslrootcert') || process.env.PGSSLROOTCERT || undefined;
  // Like libpq: verify-ca without hostname checks is only safe with a private CA.
  if (sslmode === 'verify-ca' && !sslrootcert) throw new TypeError('sslmode=verify-ca requires sslrootcert (or PGSSLROOTCERT)');
  return {
    host: url.hostname.replace(/^\[|\]$/g, '') || 'localhost',
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username || ''),
    password: decodeURIComponent(url.password || ''),
    database: decodeURIComponent(url.pathname.slice(1) || url.username || ''),
    sslmode,
    sslrootcert,
    applicationName: params.get('application_name') || 'kitsu-anime-shelf',
    // libpq-style server options, e.g. "-c search_path=myschema".
    options: params.get('options') || undefined
  };
}

// ---- Message encoding ------------------------------------------------------

class Writer {
  constructor() { this.parts = []; }
  int16(n) { const b = Buffer.alloc(2); b.writeInt16BE(n); this.parts.push(b); return this; }
  int32(n) { const b = Buffer.alloc(4); b.writeInt32BE(n); this.parts.push(b); return this; }
  cstring(s) { this.parts.push(Buffer.from(s, 'utf8'), Buffer.from([0])); return this; }
  bytes(b) { this.parts.push(b); return this; }
  message(type) {
    const body = Buffer.concat(this.parts);
    const header = Buffer.alloc(type ? 5 : 4);
    if (type) { header.write(type, 0, 'ascii'); header.writeInt32BE(body.length + 4, 1); }
    else header.writeInt32BE(body.length + 4, 0);
    return Buffer.concat([header, body]);
  }
}

function serialize(value) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return `\\x${value.toString('hex')}`;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return arrayLiteral(value);
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'bigint') return value.toString();
  return String(value);
}

function arrayLiteral(values) {
  return `{${values.map(value => {
    if (value === null || value === undefined) return 'NULL';
    if (Array.isArray(value)) return arrayLiteral(value);
    return `"${serialize(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }).join(',')}}`;
}

// ---- Result decoding -------------------------------------------------------

function parseArray(text, parseItem) {
  // One-dimensional PostgreSQL text array.
  if (text === '{}') return [];
  const items = [];
  let i = 1;
  while (i < text.length - 1) {
    let item = '';
    let quoted = false;
    if (text[i] === '"') {
      quoted = true;
      i += 1;
      while (text[i] !== '"') {
        if (text[i] === '\\') i += 1;
        item += text[i];
        i += 1;
      }
      i += 1;
    } else {
      while (i < text.length - 1 && text[i] !== ',') { item += text[i]; i += 1; }
    }
    items.push(!quoted && item === 'NULL' ? null : parseItem(item));
    i += 1; // skip comma
  }
  return items;
}

const int = text => { const n = Number(text); return Number.isSafeInteger(n) ? n : text; };
const PARSERS = new Map([
  [16, text => text === 't'],
  [17, text => Buffer.from(text.slice(2), 'hex')],
  [20, int], [21, Number], [23, Number], [26, Number],
  [700, Number], [701, Number],
  [114, JSON.parse], [3802, JSON.parse],
  [1082, text => text],
  [1114, text => new Date(`${text.replace(' ', 'T')}Z`)],
  [1184, text => new Date(text.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'))],
  [1000, text => parseArray(text, item => item === 't')],
  [1005, text => parseArray(text, Number)], [1007, text => parseArray(text, Number)],
  [1016, text => parseArray(text, int)],
  [1009, text => parseArray(text, item => item)], [1015, text => parseArray(text, item => item)],
  [2951, text => parseArray(text, item => item)]
]);

function parseErrorFields(body) {
  const fields = {};
  let offset = 0;
  while (offset < body.length && body[offset] !== 0) {
    const code = String.fromCharCode(body[offset]);
    const end = body.indexOf(0, offset + 1);
    fields[code] = body.toString('utf8', offset + 1, end);
    offset = end + 1;
  }
  return fields;
}

// ---- Single connection -----------------------------------------------------

export class PgConnection {
  constructor(config, { connectTimeoutMs = 10000, statementTimeoutMs = 15000 } = {}) {
    this.config = config;
    this.connectTimeoutMs = connectTimeoutMs;
    this.statementTimeoutMs = statementTimeoutMs;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.messages = [];
    this.queue = Promise.resolve();
    this.closed = false;
    this.broken = false;
  }

  // The timeout covers TCP connect, TLS negotiation and authentication.
  async connect() {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Database connection timed out')), this.connectTimeoutMs);
    });
    try {
      await Promise.race([this.#open(), timeout]);
      return this;
    } catch (error) {
      this.broken = true;
      this.closed = true;
      this.rawSocket?.destroy();
      this.socket?.destroy();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async #open() {
    const { host, port, sslmode } = this.config;
    let socket = await new Promise((resolve, reject) => {
      const s = net.connect({ host, port });
      this.rawSocket = s;
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    socket.setNoDelay(true);
    if (sslmode !== 'disable') {
      socket.write(new Writer().int32(SSL_REQUEST_CODE).message());
      const answer = await new Promise((resolve, reject) => {
        socket.once('data', data => resolve(String.fromCharCode(data[0])));
        socket.once('error', reject);
      });
      if (answer === 'S') {
        const verify = sslmode === 'verify-ca' || sslmode === 'verify-full';
        const options = { socket, rejectUnauthorized: verify };
        if (sslmode === 'verify-full' && !net.isIP(host)) options.servername = host;
        if (sslmode === 'verify-ca') options.checkServerIdentity = () => undefined; // CA is pinned via sslrootcert.
        if (this.config.sslrootcert) options.ca = readFileSync(this.config.sslrootcert);
        socket = await new Promise((resolve, reject) => {
          const secure = tls.connect(options, () => resolve(secure));
          this.socket = secure;
          secure.once('error', reject);
        });
        this.tls = true;
      } else if (sslmode !== 'prefer') {
        socket.destroy();
        throw new Error('The database server does not support TLS, but sslmode requires it');
      }
    }
    this.socket = socket;
    socket.on('data', data => this.#receive(data));
    socket.on('error', error => this.#fail(error));
    socket.on('close', () => this.#fail(new Error('Database connection closed')));
    await this.#startup();
  }

  #receive(data) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
    while (this.buffer.length >= 5) {
      const length = this.buffer.readInt32BE(1);
      if (this.buffer.length < length + 1) break;
      const message = { type: String.fromCharCode(this.buffer[0]), body: this.buffer.subarray(5, length + 1) };
      this.buffer = this.buffer.subarray(length + 1);
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(message);
      else this.messages.push(message);
    }
  }

  #fail(error) {
    if (this.broken) return;
    this.broken = true;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  #next() {
    if (this.messages.length) return Promise.resolve(this.messages.shift());
    if (this.broken) return Promise.reject(new Error('Database connection is not usable'));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  #send(buffer) { this.socket.write(buffer); }

  async #startup() {
    const { user, database, password, applicationName } = this.config;
    const w = new Writer().int32(PROTOCOL_VERSION)
      .cstring('user').cstring(user)
      .cstring('database').cstring(database)
      .cstring('application_name').cstring(applicationName)
      .cstring('client_encoding').cstring('UTF8');
    // Fixed date output so timestamp parsing never depends on server settings.
    const options = ['-c DateStyle=ISO,MDY -c TimeZone=UTC', this.statementTimeoutMs ? `-c statement_timeout=${Math.floor(this.statementTimeoutMs)}` : '', this.config.options || ''].filter(Boolean).join(' ');
    if (options) w.cstring('options').cstring(options);
    this.#send(w.bytes(Buffer.from([0])).message());
    let scram;
    for (;;) {
      const { type, body } = await this.#next();
      if (type === 'E') throw new PgError(parseErrorFields(body));
      if (type === 'R') {
        const code = body.readInt32BE(0);
        if (code === 0) {
          // A server that began SCRAM must prove it knows the password.
          if (scram && !scram.verified) throw new Error('Database server skipped SCRAM verification');
          continue;
        }
        if (code === 3) {
          if (!this.tls) throw new Error('Refusing to send a cleartext database password without TLS');
          this.#send(new Writer().cstring(password).message('p'));
        } else if (code === 5) {
          const salt = body.subarray(4, 8);
          const inner = createHash('md5').update(password + user).digest('hex');
          const outer = createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex');
          this.#send(new Writer().cstring(`md5${outer}`).message('p'));
        } else if (code === 10) {
          const mechanisms = body.toString('utf8', 4).split('\0').filter(Boolean);
          if (!mechanisms.includes('SCRAM-SHA-256')) throw new Error('Unsupported SASL mechanism');
          const nonce = randomBytes(18).toString('base64');
          scram = { nonce, clientFirstBare: `n=*,r=${nonce}` };
          const data = Buffer.from(`n,,${scram.clientFirstBare}`);
          this.#send(new Writer().cstring('SCRAM-SHA-256').int32(data.length).bytes(data).message('p'));
        } else if (code === 11) {
          const serverFirst = body.toString('utf8', 4);
          const attrs = Object.fromEntries(serverFirst.split(',').map(part => [part[0], part.slice(2)]));
          if (!attrs.r?.startsWith(scram.nonce)) throw new Error('SCRAM server nonce mismatch');
          const iterations = Number(attrs.i);
          if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100000) throw new Error('Invalid SCRAM iteration count');
          const salted = pbkdf2Sync(password.normalize('NFKC'), Buffer.from(attrs.s, 'base64'), iterations, 32, 'sha256');
          const clientKey = createHmac('sha256', salted).update('Client Key').digest();
          const storedKey = createHash('sha256').update(clientKey).digest();
          const finalWithoutProof = `c=biws,r=${attrs.r}`;
          const authMessage = `${scram.clientFirstBare},${serverFirst},${finalWithoutProof}`;
          const signature = createHmac('sha256', storedKey).update(authMessage).digest();
          const proof = Buffer.from(clientKey.map((byte, i) => byte ^ signature[i]));
          const serverKey = createHmac('sha256', salted).update('Server Key').digest();
          scram.serverSignature = createHmac('sha256', serverKey).update(authMessage).digest();
          this.#send(new Writer().bytes(Buffer.from(`${finalWithoutProof},p=${proof.toString('base64')}`)).message('p'));
        } else if (code === 12) {
          const final = Object.fromEntries(body.toString('utf8', 4).split(',').map(part => [part[0], part.slice(2)]));
          const verifier = Buffer.from(final.v || '', 'base64');
          if (!scram?.serverSignature || verifier.length !== 32 || !timingSafeEqual(verifier, scram.serverSignature)) throw new Error('SCRAM server signature mismatch');
          scram.verified = true;
        } else {
          throw new Error(`Unsupported PostgreSQL authentication method ${code}`);
        }
      } else if (type === 'Z') {
        return;
      }
      // ParameterStatus (S), BackendKeyData (K) and notices (N) are ignored.
    }
  }

  // Serialise use of the connection.
  #exclusive(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  query(text, values = []) {
    return this.#exclusive(async () => {
      if (this.broken) throw new Error('Database connection is not usable');
      if (!Array.isArray(values)) throw new TypeError('Query values must be an array');
      const bind = new Writer().cstring('').cstring('').int16(0).int16(values.length);
      for (const value of values) {
        const serialized = serialize(value);
        if (serialized === null) bind.int32(-1);
        else { const bytes = Buffer.from(serialized, 'utf8'); bind.int32(bytes.length).bytes(bytes); }
      }
      bind.int16(0);
      this.#send(Buffer.concat([
        new Writer().cstring('').cstring(text).int16(0).message('P'),
        bind.message('B'),
        new Writer().bytes(Buffer.from('P\0')).message('D'),
        new Writer().cstring('').int32(0).message('E'),
        new Writer().message('S')
      ]));
      return this.#guarded();
    });
  }

  // Any failure other than a PostgreSQL error leaves the protocol state
  // unknown, so the connection must never be reused.
  async #guarded() {
    try { return await this.#collect(); }
    catch (error) {
      if (!(error instanceof PgError)) { this.broken = true; this.socket?.destroy(); }
      throw error;
    }
  }

  // Simple protocol: allows several statements (used for migrations only).
  simpleQuery(text) {
    return this.#exclusive(async () => {
      this.#send(new Writer().cstring(text).message('Q'));
      return this.#guarded();
    });
  }

  async #collect() {
    let fields = [];
    let rows = [];
    let rowCount = null;
    let command;
    let error;
    for (;;) {
      const { type, body } = await this.#next();
      if (type === 'T') {
        fields = [];
        rows = [];
        let offset = 2;
        for (let i = 0, n = body.readInt16BE(0); i < n; i += 1) {
          const end = body.indexOf(0, offset);
          const name = body.toString('utf8', offset, end);
          offset = end + 1;
          const typeId = body.readInt32BE(offset + 6);
          fields.push({ name, typeId, parse: PARSERS.get(typeId) });
          offset += 18;
        }
      } else if (type === 'D') {
        const row = {};
        let offset = 2;
        for (let i = 0, n = body.readInt16BE(0); i < n; i += 1) {
          const length = body.readInt32BE(offset);
          offset += 4;
          if (length < 0) { row[fields[i].name] = null; continue; }
          const raw = body.toString('utf8', offset, offset + length);
          offset += length;
          row[fields[i].name] = fields[i].parse ? fields[i].parse(raw) : raw;
        }
        rows.push(row);
      } else if (type === 'C') {
        const tag = body.toString('utf8', 0, body.length - 1);
        const count = Number(tag.split(' ').pop());
        command = tag.split(' ')[0];
        rowCount = Number.isFinite(count) ? count : null;
      } else if (type === 'E') {
        error ??= new PgError(parseErrorFields(body));
      } else if (type === 'Z') {
        if (error) throw error;
        return { rows, rowCount, command, fields: fields.map(({ name, typeId }) => ({ name, dataTypeID: typeId })) };
      }
      // ParseComplete, BindComplete, NoData, notices and EmptyQuery are ignored.
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket?.end(new Writer().message('X')); } catch { /* already closed */ }
  }
}

// ---- Pool ------------------------------------------------------------------

export function createPool(connectionString, { max = 10, idleTimeoutMs = 30000, acquireTimeoutMs = 10000, statementTimeoutMs = 15000, logger = console } = {}) {
  const config = typeof connectionString === 'string' ? parseConnectionString(connectionString) : connectionString;
  const idle = [];
  const waiting = [];
  let total = 0;
  let ended = false;

  async function acquire() {
    if (ended) throw new Error('Database pool has been closed');
    while (idle.length) {
      const { connection, timer } = idle.pop();
      clearTimeout(timer);
      if (!connection.broken) return connection;
      total -= 1;
    }
    if (total < max) {
      total += 1;
      try { return await new PgConnection(config, { statementTimeoutMs }).connect(); }
      catch (error) { total -= 1; throw error; }
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      waiter.timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(waiter), 1);
        reject(new Error('Timed out waiting for a database connection'));
      }, acquireTimeoutMs);
      waiting.push(waiter);
    });
  }

  function release(connection) {
    if (connection.broken || ended) {
      total -= 1;
      connection.close();
      // A slot opened: let a waiter create a fresh connection.
      const waiter = waiting.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        acquire().then(waiter.resolve, waiter.reject);
      }
      return;
    }
    const waiter = waiting.shift();
    if (waiter) { clearTimeout(waiter.timer); waiter.resolve(connection); return; }
    const timer = setTimeout(() => {
      const index = idle.findIndex(item => item.connection === connection);
      if (index >= 0) { idle.splice(index, 1); total -= 1; connection.close(); }
    }, idleTimeoutMs);
    timer.unref?.();
    idle.push({ connection, timer });
  }

  async function withConnection(task) {
    const connection = await acquire();
    try { return await task(connection); }
    finally { release(connection); }
  }

  return {
    query: (text, values) => withConnection(connection => connection.query(text, values)),
    withConnection,
    async transaction(task) {
      return withConnection(async connection => {
        await connection.query('BEGIN');
        try {
          const result = await task({ query: (text, values) => connection.query(text, values) });
          await connection.query('COMMIT');
          return result;
        } catch (error) {
          try { await connection.query('ROLLBACK'); }
          catch (rollbackError) { connection.broken = true; logger.error?.(`Rollback failed: ${rollbackError.message}`); }
          throw error;
        }
      });
    },
    async end() {
      ended = true;
      for (const { connection, timer } of idle.splice(0)) { clearTimeout(timer); await connection.close(); }
      for (const waiter of waiting.splice(0)) { clearTimeout(waiter.timer); waiter.reject(new Error('Database pool has been closed')); }
    },
    get stats() { return { total, idle: idle.length, waiting: waiting.length }; }
  };
}
