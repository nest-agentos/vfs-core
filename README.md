# @itookit/vfs-core

Independent virtual filesystem contracts, engine, views, records and events. Runtime dependencies: `yaml` and `ignore`. No application, UI, session, driver or sync dependencies.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm pack
```

```ts
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
const fs = await manager.openFileSystem('/');
await fs.driver.createFile({ parentPath: '/', name: 'hello.txt', content: 'Hello' });
await manager.dispose();
```

The workspace uses source exports; `pnpm pack` replaces them with the ESM/CJS and declaration exports in `publishConfig`. Testing helpers have a separate `@itookit/vfs-core/testing` entry. Drivers implement storage contracts; host applications inject project policy. Optional sync integration must live outside this repository.

See [development instructions](AGENTS.md), [key classes](doc/key-classes.md) and [entry point](src/index.ts).

In itookit this repository is mounted at `packages/vfs-core` as a Git submodule. After cloning itookit run `git submodule update --init packages/vfs-core` before installing dependencies.
