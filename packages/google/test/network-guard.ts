import net from 'node:net';
import { afterAll, afterEach, beforeAll } from 'vitest';

/**
 * Fails any test that reaches the real network. A second msw server started in a setup file
 * stacks with the servers individual tests start (handlers then run twice per request), so the
 * guard sits one level lower: it refuses every TCP connection that is not to this machine. Unix
 * sockets (the Postgres socket) and 127.0.0.1 / localhost / ::1 are allowed. Requests that a
 * test's own msw handlers answer never open a socket, so they are unaffected. The error is also
 * recorded and rethrown after the test, so code that swallows network errors cannot hide it.
 * RUN_LLM_SMOKE=1 (the explicit opt-in for the real-API smoke tests) lifts the guard.
 */
const LOCAL = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const blocked: string[] = [];

type Connect = (...args: unknown[]) => net.Socket;
const proto = net.Socket.prototype as unknown as { connect: Connect };
const realConnect = proto.connect;
const normalizeArgs = (
  net as unknown as { _normalizeArgs: (a: unknown[]) => [Record<string, unknown>, unknown] }
)._normalizeArgs;

function install() {
  proto.connect = function guarded(this: net.Socket, ...args: unknown[]) {
    const [options] = normalizeArgs(args);
    if (typeof options.path === 'string') return realConnect.apply(this, args);
    const host = String(options.host ?? 'localhost');
    if (LOCAL.has(host)) return realConnect.apply(this, args);
    const target = `${host}:${String(options.port)}`;
    blocked.push(target);
    const err = new Error(`network guard: blocked a real connection to ${target}`);
    queueMicrotask(() => this.destroy(err));
    return this;
  };
}

beforeAll(() => {
  if (process.env.RUN_LLM_SMOKE !== '1') install();
});
afterAll(() => {
  proto.connect = realConnect;
});
afterEach(() => {
  if (blocked.length) {
    const hosts = [...new Set(blocked.splice(0))].join(', ');
    throw new Error(`network guard: the test tried to reach the real network (${hosts})`);
  }
});
