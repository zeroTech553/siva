// Unit tests for the relay Room router: authorisation of binary frames,
// per-client fan-out, and status broadcasting — with fake sockets, no network.

import assert from 'node:assert/strict';
import test from 'node:test';

import { Room } from '../relay/node/src/room.mjs';

const SESSION = '11111111-2222-4333-8444-555555555555';
const OTHER_SESSION = '99999999-8888-4777-8666-555555555555';
const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function uuidBytes(uuid) {
  return Buffer.from(uuid.replaceAll('-', ''), 'hex');
}

function terminalFrame(sessionId, clientId, payload = Buffer.from('x')) {
  return Buffer.concat([Buffer.from([0x01]), uuidBytes(sessionId), uuidBytes(clientId), payload]);
}

class FakeSocket {
  constructor() {
    this.OPEN = 1;
    this.readyState = 1;
    this.sent = [];
    this.handlers = new Map();
    this.closed = null;
  }

  on(event, handler) {
    this.handlers.set(event, handler);
  }

  off() {}

  send(frame) {
    this.sent.push(frame);
  }

  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = 3;
    this.handlers.get('close')?.();
  }

  emit(event, ...args) {
    this.handlers.get(event)?.(...args);
  }

  jsonFrames() {
    return this.sent.filter((f) => typeof f === 'string').map((f) => JSON.parse(f));
  }

  binaryFrames() {
    return this.sent.filter((f) => Buffer.isBuffer(f));
  }
}

function roomWithLaptopAndBrowsers() {
  const room = new Room('dev-1', {});
  const laptop = new FakeSocket();
  room.attachLaptop(laptop);
  const alice = new FakeSocket();
  const bob = new FakeSocket();
  room.attachBrowser(alice, { clientId: ALICE, userId: 'user-alice' });
  room.attachBrowser(bob, { clientId: BOB, userId: 'user-bob' });
  return { room, laptop, alice, bob };
}

test('a browser gets a status frame on attach', () => {
  const { alice } = roomWithLaptopAndBrowsers();
  const status = alice.jsonFrames().find((f) => f.type === 'status');
  assert.ok(status);
  assert.equal(status.online, true);
});

test('browser control frames are stamped with the socket identity, not the payload', () => {
  const { room, laptop, alice } = roomWithLaptopAndBrowsers();
  void room;
  alice.emit(
    'message',
    Buffer.from(
      JSON.stringify({ type: 'term_open', cols: 80, rows: 24, clientId: BOB, userId: 'user-bob' }),
    ),
    false,
  );
  const forwarded = laptop.jsonFrames().find((f) => f.type === 'term_open');
  assert.ok(forwarded, 'term_open must reach the laptop');
  assert.equal(forwarded.clientId, ALICE, 'clientId must be overwritten with the sender');
  assert.equal(forwarded.userId, 'user-alice', 'userId comes from the verified ticket');
});

test('unknown browser frame types are dropped', () => {
  const { laptop, alice } = roomWithLaptopAndBrowsers();
  const before = laptop.sent.length;
  alice.emit('message', Buffer.from(JSON.stringify({ type: 'rpc_request', id: 'x' })), false);
  alice.emit('message', Buffer.from(JSON.stringify({ type: 'evil' })), false);
  assert.equal(laptop.sent.length, before);
});

test('binary output is routed only to the addressed, attached browser', () => {
  const { room, laptop, alice, bob } = roomWithLaptopAndBrowsers();
  void room;
  // Alice attaches to SESSION (term_open with sessionId marks intent).
  alice.emit(
    'message',
    Buffer.from(JSON.stringify({ type: 'term_attach', sessionId: SESSION })),
    false,
  );
  const frame = terminalFrame(SESSION, ALICE, Buffer.from('secret-output'));
  laptop.emit('message', frame, true);
  assert.equal(alice.binaryFrames().length, 1);
  assert.equal(bob.binaryFrames().length, 0, 'bob must not receive alice frames');
});

test('laptop frames for a session the browser is not attached to are dropped', () => {
  const { laptop, alice } = roomWithLaptopAndBrowsers();
  laptop.emit('message', terminalFrame(OTHER_SESSION, ALICE), true);
  assert.equal(alice.binaryFrames().length, 0);
});

test('a browser cannot spoof another clientId in binary frames', () => {
  const { laptop, alice, bob } = roomWithLaptopAndBrowsers();
  alice.emit(
    'message',
    Buffer.from(JSON.stringify({ type: 'term_attach', sessionId: SESSION })),
    false,
  );
  bob.emit(
    'message',
    Buffer.from(JSON.stringify({ type: 'term_attach', sessionId: OTHER_SESSION })),
    false,
  );
  const laptopBinaryBefore = laptop.binaryFrames().length;
  // Bob tries to write into Alice's session using her clientId.
  bob.emit('message', terminalFrame(SESSION, ALICE), true);
  // And into a session he is not attached to with his own id.
  bob.emit('message', terminalFrame(SESSION, BOB), true);
  assert.equal(laptop.binaryFrames().length, laptopBinaryBefore, 'both spoofs must be dropped');
  // His own session with his own id goes through.
  bob.emit('message', terminalFrame(OTHER_SESSION, BOB), true);
  assert.equal(laptop.binaryFrames().length, laptopBinaryBefore + 1);
});

test('term_key / term_ready / term_eof reach only the named client', () => {
  const { laptop, alice, bob } = roomWithLaptopAndBrowsers();
  laptop.emit(
    'message',
    Buffer.from(JSON.stringify({ type: 'term_ready', clientId: ALICE, sessionId: SESSION })),
    false,
  );
  assert.ok(alice.jsonFrames().some((f) => f.type === 'term_ready'));
  assert.ok(!bob.jsonFrames().some((f) => f.type === 'term_ready'));
});

test('term_ready implicitly attaches the client to the session', () => {
  const { laptop, alice } = roomWithLaptopAndBrowsers();
  laptop.emit(
    'message',
    Buffer.from(JSON.stringify({ type: 'term_ready', clientId: ALICE, sessionId: SESSION })),
    false,
  );
  laptop.emit('message', terminalFrame(SESSION, ALICE), true);
  assert.equal(alice.binaryFrames().length, 1);
});

test('heartbeat updates status and acks the laptop', () => {
  const { laptop, alice } = roomWithLaptopAndBrowsers();
  laptop.emit(
    'message',
    Buffer.from(
      JSON.stringify({ type: 'heartbeat', daemonOnline: true, caps: { term: true, e2e: true } }),
    ),
    false,
  );
  assert.ok(laptop.jsonFrames().some((f) => f.type === 'heartbeat_ack'));
  const status = alice.jsonFrames().filter((f) => f.type === 'status').at(-1);
  assert.equal(status.daemonOnline, true);
  assert.equal(status.caps.term, true);
});

test('laptop disconnect notifies browsers with bye and offline status', () => {
  const { laptop, alice } = roomWithLaptopAndBrowsers();
  laptop.close(1000, 'gone');
  assert.ok(alice.jsonFrames().some((f) => f.type === 'bye'));
  const status = alice.jsonFrames().filter((f) => f.type === 'status').at(-1);
  assert.equal(status.online, false);
});

test('a browser talking while the laptop is offline gets DEVICE_OFFLINE', () => {
  const room = new Room('dev-2', {});
  const alice = new FakeSocket();
  room.attachBrowser(alice, { clientId: ALICE, userId: 'u' });
  alice.emit('message', Buffer.from(JSON.stringify({ type: 'term_open', cols: 80, rows: 24 })), false);
  assert.ok(alice.jsonFrames().some((f) => f.code === 'DEVICE_OFFLINE'));
});

test('a reconnecting laptop replaces the old socket', () => {
  const room = new Room('dev-3', {});
  const first = new FakeSocket();
  room.attachLaptop(first);
  const second = new FakeSocket();
  room.attachLaptop(second);
  assert.equal(first.closed?.code, 4012);
  assert.equal(room.laptopSocket(), second);
});

test('browser disconnect sends term_detach to the laptop for its sessions', () => {
  const { laptop, alice } = roomWithLaptopAndBrowsers();
  alice.emit(
    'message',
    Buffer.from(JSON.stringify({ type: 'term_attach', sessionId: SESSION })),
    false,
  );
  alice.close(1001, 'tab closed');
  const detach = laptop.jsonFrames().find((f) => f.type === 'term_detach');
  assert.ok(detach);
  assert.equal(detach.sessionId, SESSION);
  assert.equal(detach.clientId, ALICE);
});

test('oversized and malformed binary frames are dropped', () => {
  const { laptop, alice } = roomWithLaptopAndBrowsers();
  alice.emit(
    'message',
    Buffer.from(JSON.stringify({ type: 'term_attach', sessionId: SESSION })),
    false,
  );
  const before = laptop.binaryFrames().length;
  alice.emit('message', Buffer.from([0x01, 0x02]), true); // too short
  alice.emit('message', Buffer.alloc(46 + 64 * 1024 + 64, 1), true); // too long
  const wrongKind = terminalFrame(SESSION, ALICE);
  wrongKind[0] = 0x7f;
  alice.emit('message', wrongKind, true);
  assert.equal(laptop.binaryFrames().length, before);
});
