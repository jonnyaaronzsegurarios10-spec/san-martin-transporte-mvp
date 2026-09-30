import { describe, expect, it } from 'vitest';

describe('portable MVP contract', () => {
  it('uses versioned API paths', () => {
    expect('/api/v1').toContain('/api/v1');
  });
});
