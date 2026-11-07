import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { resetState, server } from './server';

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) =>
  realFetch(
    typeof input === 'string' && input.startsWith('/')
      ? new URL(input, window.location.origin).toString()
      : input,
    init,
  );

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetState();
});
afterAll(() => server.close());
