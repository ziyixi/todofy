/** Synthetic deploy inputs. No account, token, keyring or network reads. */
import { describe, expect, it } from 'vitest';
import { generateSecrets, injectedVars, placeholderIn } from '../../deploy/deploy-vars.mjs';

const values = {
  GITHUB_SHA: '1'.repeat(40),
  FLEET_ACCESS_OWNER: 'owner@example.com',
  FLEET_ACCESS_OWNER_ALIASES: 'alias@example.com',
  FLEET_REPORT_HMAC_KEY: 'a'.repeat(64),
};

describe('Fleet production deploy values', () => {
  it('keeps the machine report identity independent and needs no owner mutation key', () => {
    expect(injectedVars(values)).toEqual({ BUILD_SHA: values.GITHUB_SHA });
    expect(generateSecrets(values)).toEqual({
      ACCESS_OWNER: 'owner@example.com',
      ACCESS_OWNER_ALIASES: 'alias@example.com',
      REPORT_HMAC_KEY: 'a'.repeat(64),
    });
  });

  it.each(['GITHUB_SHA', 'FLEET_ACCESS_OWNER', 'FLEET_ACCESS_OWNER_ALIASES', 'FLEET_REPORT_HMAC_KEY'])('refuses missing %s', (field) => {
    const env = { ...values, [field]: undefined };
    expect(() => field === 'GITHUB_SHA' ? injectedVars(env) : generateSecrets(env)).toThrow(field);
  });

  it('explicitly clears aliases when the allowlist is empty', () => {
    expect(generateSecrets({ ...values, FLEET_ACCESS_OWNER_ALIASES: '' }).ACCESS_OWNER_ALIASES).toBe(' ');
  });

  it.each(['', '0'.repeat(64), 'not-an-audience'])('marks absent or invalid Access audience as undeployable', (audience) => {
    expect(placeholderIn(`[vars]\nACCESS_AUDIENCE="${audience}"\n`)).toBe('ACCESS_AUDIENCE');
  });

  it('accepts a configured non-placeholder audience', () => {
    expect(placeholderIn(`ACCESS_AUDIENCE="${'b'.repeat(64)}"`)).toBeNull();
  });
});
