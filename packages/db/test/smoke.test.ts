import { describe, expect, it } from 'vitest';
import { createDb } from '../src';

describe('db package', () => {
  it('exports createDb', () => {
    expect(typeof createDb).toBe('function');
  });
});
