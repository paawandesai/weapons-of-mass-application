import { describe, expect, it } from 'vitest';
import { createBoss } from '../src/boss';

describe('createBoss', () => {
  it('constructs a queue client without connecting', () => {
    expect(createBoss('postgres://wma:wma@localhost:5432/wma')).toBeDefined();
  });
});
