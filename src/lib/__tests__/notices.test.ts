import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { THIRD_PARTY_NOTICES } from '../../generated/third-party-notices';

describe('third-party notices', () => {
  it('the in-app copy matches THIRD_PARTY_NOTICES.md (run `npm run notices` after dependency changes)', () => {
    const file = readFileSync(join(__dirname, '../../../THIRD_PARTY_NOTICES.md'), 'utf8');
    expect(THIRD_PARTY_NOTICES).toBe(file);
    expect(file).toContain('Copyright (c) 2026 T3 Tools Inc.');
    expect(file).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(file).toContain('Phonon-2 by Fermion');
    expect(file).toContain('nvidia/parakeet-tdt-0.6b-v3');
    expect(file).toContain('https://huggingface.co/FermionResearch/Phonon-2-CoreML');
    expect(file).toContain('Apache License');
    expect(file).toContain('Kevin Atkinson');
  });
});
