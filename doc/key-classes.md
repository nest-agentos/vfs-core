# vfs-core 关键类型速查

完整设计见 [VFS 设计](https://github.com/mushuanli/itookit/blob/main/doc/design/VFS-design.md)，导出清单见 [index.ts](../src/index.ts)。

## IFileSystem

消费方唯一入口（受限视图）：`viewId` / `revision` / `capabilities` / `driver` / `meta` / `external?`，方法为 `openFile(path)` 与 `capabilitiesAt(path)`。

## FileSystemView

`IFileSystem` 实现：把多个挂载点组合成一个固定 `revision` 的视图，过滤返回值与事件；`dispose()` 只销毁视图，不销毁来源。

```typescript
createFileSystemView({
    viewId, revision?, tags?, external?,
    mounts: [{ mountId, at: '/', fs, root?, access: 'ro' | 'rw' }],
    readablePaths?,
});
```

## FileSystemSource

`createFileSystemSource({ backend, viewId, access?, tags?, internal? })` 把宿主已授权的 `IStorageBackend` 包成来源，返回 `{ fs, dispose }`。

## VFSManager

实现 `IVFSManager`，宿主专用（不注入 Session 或编辑器）：`initialize()` / `dispose()` / `openFileSystem(rootPath)`；子服务 `mounts` / `devices` / `plugins`；设备节点 `registerDevice` / `openDevice` / `createDeviceNode` / `removeDeviceNode`；系统路径 `readBySystemPath`；诊断用引擎操作计数 `ioStats`（副本快照）/ `resetIOStats()`，仅统计已埋点操作，不代表完整后端调用数或 IPC 次数。

## createVFS()

```typescript
const { manager, config } = await createVFS({
    rootBackend: myBackend,                                            // 必填
    additionalMounts: [{ path: '/archive', backend, options: { syncable: true } }],
    devices: [], plugins: [], initialConfigs: {}, filenamePattern,
});
```

除 `rootBackend` 外全部可选：`additionalMounts` 在初始化时挂载额外后端，`devices` / `plugins` 注册内置驱动与插件，`initialConfigs` 仅在配置不存在时写入，`filenamePattern` 覆盖文件名校验正则。

返回 `{ manager, config }`，其中 `config` 是 `ConfigService`（实现 `IConfigService`：`getAll` / `setBatch` / `onChange` 等）。

## VFSEngine

`VFSManager` 内部的路径引擎：持有 `events`（`FSEventBus`）、`plugins`（`PluginPipeline`）、`devices`（`DeviceRegistry`）与挂载路由，负责系统路径 CRUD 与后端分派。
