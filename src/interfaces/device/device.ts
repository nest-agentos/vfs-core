/**
 * @file packages/vfs-core/src/interfaces/device/device.ts
 * @desc 虚拟设备驱动
 *
 * 设计：
 * - sessionable 设备（如 LLM）：open → write/read → close
 * - 无状态设备（如 /dev/null）：直接 read/write
 * - readStream 用于流式 LLM 响应
 * - ioctl 用于设备特定控制命令
 */

import type { FileContent } from '../core/types';
import type { IIOStream } from '../io';

export interface DeviceContext {
    /** 设备节点 ID */
    nodeId: string;
    /** 设备节点名称 */
    name: string;
    /** 节点元数据 */
    metadata?: Record<string, unknown>;
    /** 会话 ID（sessionable 设备需要） */
    sessionId?: string;
    /**
     * 系统 /etc 访问接口。
     * 设备驱动可通过此接口以系统身份读写 /etc 路径（含隐藏文件）。
     * 仅在通过 IFileSystem.openDevice() 打开设备时注入。
     */
    systemAccess?: import('../system-access').ISystemAccess;
}

export interface IDeviceDriver {
    /** 处理器唯一标识符 */
    readonly handlerId: string;
    /** 人类可读描述 */
    readonly description?: string;
    /** 是否支持写入 */
    readonly writable: boolean;
    /** 是否支持流式读取 */
    readonly streamable?: boolean;
    /** 是否支持多会话 */
    readonly sessionable?: boolean;

    /** 打开会话 @returns 会话 ID */
    open?(ctx: DeviceContext, options?: Record<string, unknown>): Promise<string>;

    /** 关闭会话 */
    close?(ctx: DeviceContext): Promise<void>;

    /** 读取 */
    read(ctx: DeviceContext): Promise<FileContent>;

    /** 写入 */
    write(ctx: DeviceContext, content: FileContent): Promise<void>;

    /** 流式读取 */
    readStream?(ctx: DeviceContext): AsyncIterable<string | ArrayBuffer>;

    /** 设备控制命令 */
    ioctl?(ctx: DeviceContext, command: string | number, arg?: unknown): Promise<unknown>;

    /** 设备初始化 */
    init?(): Promise<void>;

    /** 设备销毁（应关闭所有活跃会话） */
    dispose?(): Promise<void>;
}

export interface IDeviceManager {
    register(driver: IDeviceDriver): void;
    unregister(handlerId: string): void;
    has(handlerId: string): boolean;
    get(handlerId: string): IDeviceDriver;
    list(): string[];
    /** 冻结注册表，后续 register/unregister 均抛出 FSDeviceFrozenError */
    freeze(): void;
    /** 查询是否已冻结 */
    isFrozen(): boolean;
}

/**
 * 从已有的驱动实例和上下文创建 IDeviceHandle。
 *
 * 供无法访问 IFileSystem（VFS 路径）的调用方使用：
 *   const sessionId = await driver.open!(baseCtx, options);
 *   const handle = createDeviceHandle(driver, { ...baseCtx, sessionId });
 *   await handle.write(data);
 *   await handle.close();
 */
export function createDeviceHandle(
    driver: IDeviceDriver,
    ctx: DeviceContext,
): IDeviceHandle {
    return {
        ctx,
        read: () => driver.read(ctx),
        write: (content) => driver.write(ctx, content),
        async *readStream() {
            if (!driver.readStream) throw new Error(`Device '${driver.handlerId}' is not streamable`);
            yield* driver.readStream(ctx);
        },
        ioctl: (command, arg) => {
            if (!driver.ioctl) throw new Error(`Device '${driver.handlerId}' does not support ioctl`);
            return driver.ioctl(ctx, command, arg);
        },
        close: () => driver.close?.(ctx) ?? Promise.resolve(),
    };
}

/**
 * 打开设备文件后返回的句柄。
 *
 * 通过 `IFileSystem.openDevice(path, opts)` 获取：
 *   const dev = await engine.openDevice('/dev/llm', { connectionId: 'default' });
 *   await dev.write(prompt);
 *   for await (const chunk of dev.readStream()) { ... }
 *   await dev.close();
 */
export interface IDeviceHandle extends IIOStream {
    /** 绑定的设备节点上下文（含 sessionId） */
    readonly ctx: DeviceContext;
    /** 读取设备输出 */
    read(): Promise<FileContent>;
    /** 写入数据到设备 */
    write(content: FileContent): Promise<void>;
    /** 流式读取（streamable 设备） */
    readStream(): AsyncIterable<string | ArrayBuffer>;
    /** 设备控制命令 */
    ioctl(command: string | number, arg?: unknown): Promise<unknown>;
    /** 关闭会话 */
    close(): Promise<void>;
}
