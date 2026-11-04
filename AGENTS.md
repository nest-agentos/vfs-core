# @itookit/vfs-core

VFS 唯一入口 — 协议层 + 引擎实现 + 事件总线 + 工具。

## 定位

- **协议层**:跨包契约(`IFileSystem`、`IFileSystemDriver`、`IFSMetaDriver`、`IStorageBackend`、`IVFSManager`、`FSNode`、`FSError` 族等)——只定义类型/接口/常量/错误类。
- **引擎层**:实现(`VFSEngine`、`VFSManager`、`FSEventBus`、`ConfigService`、`createVFS` 等)。
- **事件总线**:通用 `EventBus`/`EventBuffer`,被 VFS 与 LLM/UI 共用。
- **工具**:`guessMimeType`、序列化、编码、路径、校验、`pipe` 等。

**依赖**:`yaml`(序列化)、`ignore`（Git ignore 语法匹配）。不依赖 `@itookit/common`。

## 结构

```
src/
├── index.ts           统一导出 (协议 + 引擎 + eventbus + utils)
├── protocol.ts        协议层 barrel (接口/类型/常量/错误)
├── interfaces/        协议契约层 — 只定义接口/类型/常量/错误类
│   ├── constants.ts   常量 (SYSTEM_DIRS 等)
│   ├── core/          核心类型、错误、事件、选项
│   ├── storage/       存储后端接口 (IStorageBackend / IRecordStore)
│   ├── capabilities/  可选能力子接口 (assets/tags/seq/refs/watch)
│   ├── device/        虚拟设备驱动接口
│   ├── plugin/        插件/中间件系统接口
│   ├── mount/         挂载系统接口
│   ├── services/      服务接口 (file-system/vfs-manager/config-service/fs-driver/fs-meta-driver/factory)
│   ├── io.ts          IIOStream 等通用 IO 契约
│   ├── IFile.ts       IFile / AssetObj
│   ├── IMDXFile.ts    IMDXFile
│   └── system-access.ts ISystemAccess
├── impl/              引擎实现层
│   ├── factory.ts     createVFS
│   ├── engine/        VFSEngine, DeviceRegistry, PluginPipeline
│   ├── services/      VFSManager, ConfigService, DirectoryFS/DirectoryDriver/DirectoryContext,
│   │                  FileSystemView/createFileSystemView, FileSystemSource/createFileSystemSource,
│   │                  ScopedView, MountService, copy-tree, file-system-archive
│   ├── capabilities/  SeqFileOps, RefOps, AssetOps, TagOps (依赖 EnginePort)
│   ├── file-io/       FileHandle, MDXFileHandle
│   ├── devices/       nullDevice, zeroDevice, randomDevice
│   └── event/         FSEventBus
├── eventbus/          通用事件总线 (EventBus, EventBuffer)
├── testing/           测试工具 + MemoryBackend (内存参考后端)
└── utils/             path, validation, encoding, id, serialization, guess-mime-type, pipe
```

**约定**:`interfaces/` 内禁止引用 `impl/`(协议不依赖实现);`impl/` 通过 `protocol.ts` barrel 引用协议,不直接引 `interfaces/` 内部文件。

## 通用 IO (IIOStream + pipe)

`IIOStream`(`read` / `write` / `readStream?` / `close?`)是文件与设备的公共流语义最小公约数:`IFile`(fs io)与 `IDeviceHandle`(llm/tty io)都 extends 它。

`pipe(source, target, opts)` 把源流复制到目标流(优先 `readStream`,回退 `read`),用于 LLM↔文件、文件↔TTY、TTY↔LLM 等衔接。

**注意**:`write` 语义由实现定义 — 设备为发送,文件为覆盖(非追加)。

## 引擎分层 (path-based)

```
IFileSystem (view)
  ├── driver: IFileSystemDriver  ← readContent/writeContent/createFile/createDirectory/getNode/…(DirectoryDriver)
  ├── meta:   IFSMetaDriver      ← assets / tags / seq? / refs?
  ├── openFile(path) → IFile
  └── capabilitiesAt(path) → FSCapabilities
```

`createVFS({ rootBackend, additionalMounts?, devices?, plugins?, initialConfigs?, filenamePattern? })` 是唯一初始化入口(内部会 `init()` 根后端);`VFSManager.openFileSystem(rootPath)` 打开视图,`createFileSystemView({ viewId, mounts, fs })` 组合多个挂载,`createFileSystemSource({ backend, viewId, access })` 以 `IStorageBackend` 挂出一个只读/可写视图。

## 能力检查的廉价路径 (`statType` / `getNodeType`)

`FileSystemView.noLinks` 会对**每个路径前缀**做一次类型检查(拒绝 link/device 节点)。它只需要 `type`,不需要元数据,因此:

- `IStorageBackend` 可选实现 `statType(path)`(类型必须与 `stat` 同源，但可跳过元数据);
- `IFSDriver` 可选实现 `getNodeType(path)`,`DirectoryDriver` 已用 `VFSEngine.tryStatType` 实现;
- `FileSystemView.makeDriver()` 同样暴露 `getNodeType`(指向私有 `statType`:先做 `noLinks`、再优先用内层 driver 的 `getNodeType`),因此**嵌套视图**的前缀检查也免元数据;
- `noLinks` 优先调用 `getNodeType`,缺失时回退 `getNode`;各前缀检查**并发发起**(仍按前缀顺序判定),这样后端能把同一 tick 的类型查询合并成一次宿主调用(`LocalFSBackend` 微批处理 → `fs_stat_many`)。
- `noLinks` 返回本轮已检查的目标类型，`statType` 必须复用它；嵌套视图若再次查询目标，会按嵌套深度指数放大（4 层曾从 1 次变为 16 次）。

SeqFile 的 `getEntries` 在事务内优先调用记录后端可选的 `getRecordFields`，把已知字段集合合成一次存储读取；`mapRecordPaths` 必须同时转发这个可选能力。不能用跨事务读缓存替代该批量接口，跨进程写入须保持可见。

**多路径批量读 `getEntriesMany(requests)`**：一次读多个文件的同名/异名键，是「扫描 N 个 Task 记录」这类循环的正解。契约：结果顺序与 `requests` 一致，文件或键缺失返回 `null`（后端 ENOENT 也降级为 `null`，不抛错）；路径解析失败之外的错误照常抛出。优先用后端可选的 `getRecordFieldsMany`，未实现时退化为逐条读取，因此**后端可以逐步接入**（`MemoryRecordStore` / localfs `BetterSqliteSidecarDb` / CLI `NodeSqliteSidecarDb` / `IDBRecordStore` / 桌面 `TauriSqlSidecarDb` 均已实现）。`mapRecordPaths`、`FileSystemView`（虚拟路径 → 挂载源路径，含挂载/EACCES 校验）都必须转发，否则批量能力会在视图层丢失。收益（CLI 引导成本 fixture，3 Session + 9 终态 Task）：`994 → 814` 次 sidecar 调用，`220 → 175` 个事务。回归：`tests/06-seq-file.test.ts`「getEntriesMany reads many files in request order…」「issues one backend batch call and falls back…」。

`FileSystemView` 对非事务的 `getEntriesMany` 在一次调用内共用前缀类型检查 Promise；相同父路径与重复目标只检查一次，仍逐请求校验读权限及挂载，调用结束即丢弃结果。事务内继续使用同步路径/挂载校验，不在 IndexedDB 事务中等待节点 IO。回归见 `tests/23-io-stats.test.ts`。

对桌面 LocalFS,前缀检查原本每次要付一次 `getMetaExt` IPC(且计入 `ioStats.stat`);实测一次聊天发送的前缀检查从 653 次 VFS stat 降到 114,合并 IPC 后发送延迟从 5.66s 降到 4.21s。**新增后端时若 `stat` 有远程/侧车往返,应实现 `statType`(并让 `fsOps` 提供批量 `statMany`);新增 driver 时实现 `getNodeType`。** 语义不变:类型仍来自与 `stat` 相同的底层调用,只是不取元数据、并把同 tick 的调用合并成一次往返。

## 消费关系

- `@itookit/ui-common` 的 `IEditor` 引用 vfs-core 的 `IFileSystem` 类型。
- `@itookit/vfsdriver-indexeddb` / `@itookit/vfsdriver-localfs` 依赖 vfs-core,实现 `IStorageBackend`。
- 各业务/UI 包(VFS 类型)直接依赖 vfs-core。

## 事件总线注意

- `EventBus` / `EventBuffer`(eventbus/)——通用,LLM/UI 包也在用,从根导出。
- `FSEventBus`(impl/event/)——VFS 唯一事件总线,extends EventBus,类型化为 `FSEventPayloadMap`:`seq:committed`、`node:created/updated/deleted/moved/copied/renamed`、`mount:added/removed`、`error`;同一文件还导出事务用的 `TransactionEventBuffer`。

关键类型速查见 [key-classes.md](./doc/key-classes.md)。

## 测试

```bash
pnpm --filter @itookit/vfs-core test        # vitest run — 引擎 + 协议集成测试
pnpm --filter @itookit/vfs-core typecheck   # tsc --noEmit
```

LocalFS 后端测试在 `@itookit/vfsdriver-localfs`,IndexedDB 后端测试在 `@itookit/vfsdriver-indexeddb`。

文件发现使用 `discoverFiles` + `FileDiscoverySource`：每次搜索从授权边界继承 `.gitignore` / `.mindosignore`，在遍历前剪枝，缓存仅限本次搜索。`IFileSystem.discoveryRoot` 可选声明规则边界；FileSystemView 必须透传嵌套视图边界并限制在当前挂载内。忽略规则不改变直接读写权限。回归在 `tests/file-discovery.test.ts`。

在线文件传输使用 `transferFileSystemEntry`（源/目标授权 `IFileSystem`、源路径、目标目录）。它拒绝覆盖、保留内容/记录/附件并在移动删除前复核源；跨存储不承诺原子性。`copyFileSystemTree` 仍仅用于静默启动迁移，不用于在线文件管理。
