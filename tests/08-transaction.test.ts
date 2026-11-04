import { describe, it, expect } from 'vitest';
import { setupVFS } from './helpers';

describe('file transaction capability', () => {
    it('rejects before executing any writes when the backend does not guarantee atomic file transactions', async () => {
        const { fs, dispose } = await setupVFS();
        try {
            let entered = false;
            await expect(fs.driver.transaction(async tx => {
                entered = true;
                await tx.createFile({ name: 'partial.txt', parentPath: '/', content: 'partial' });
                throw new Error('abort');
            })).rejects.toMatchObject({ code: 'ECAPABILITY' });
            expect(entered).toBe(false);
            expect(await fs.driver.exists('/partial.txt')).toBe(false);
        } finally { await dispose(); }
    });
});
