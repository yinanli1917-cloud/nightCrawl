import { describe, test, expect } from 'bun:test';
import { validateNavigationUrl } from '../src/url-validation';
import { HostileDomainError } from '../src/hostile-domains';

describe('validateNavigationUrl hostile platforms', () => {
  test('blocks xiaohongshu.com on default profile', async () => {
    await expect(
      validateNavigationUrl('https://www.xiaohongshu.com/explore'),
    ).rejects.toBeInstanceOf(HostileDomainError);
  });

  test('allows example.com', async () => {
    await expect(validateNavigationUrl('https://example.com/')).resolves.toBeUndefined();
  });
});
