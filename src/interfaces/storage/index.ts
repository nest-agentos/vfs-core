/**
 * @file packages/vfs-core/src/interfaces/storage/index.ts
 * @desc 存储层统一导出（v4.1: 简化为 path-based 单一接口）
 */

// 主接口
export type { IStorageBackend } from './backend';
export { hasRecordStore } from './backend';

// 可选增强
export type {
    RecordValue,
    QueryOperator,
    RecordQuery,
    RecordQueryOptions,
    RecordQueryResult,
    RecordWalkOptions,
    RecordFieldRequest,
    IRecordTransaction,
    IRecordStore,
} from './record-backend';
