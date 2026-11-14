import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        protocol: 'src/protocol.ts',
        path: 'src/utils/virtual-path.ts',
        'testing/index': 'src/testing/index.ts',
    },
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    external: ['yaml'],
    splitting: true,
    treeshake: true,
});
