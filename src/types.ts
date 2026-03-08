/** 消息角色 */
export type Role = 'user' | 'assistant'

/** 单条对话消息 */
export interface ChatMessage {
  id: string
  role: Role
  content: string
  /** 是否正在流式输出中 */
  streaming?: boolean
}

/** 虚拟列表中每个条目的位置信息 */
export interface ItemPosition {
  index: number
  /** 距顶部偏移量 */
  top: number
  /** 条目高度 */
  height: number
  /** 底部位置 = top + height */
  bottom: number
}

/** 高度变更记录，用于入队异步处理 */
export interface HeightDiff {
  index: number
  newHeight: number
}

/**
 * 虚拟化的最小渲染单元：一个 Markdown 块
 *
 * 一条消息可能被拆分为多个 VirtualBlock，
 * 通过 isFirstBlock / isLastBlock 控制视觉分组。
 */
export interface VirtualBlock {
  /** 唯一标识：`${messageId}-b${blockIndex}` */
  id: string
  /** 所属消息 ID */
  messageId: string
  /** 该块的 Markdown 原文 */
  content: string
  /** 消息角色 */
  role: Role
  /** 是否是该消息的第一个块（显示角色标签 + 顶部圆角） */
  isFirstBlock: boolean
  /** 是否是该消息的最后一个块（底部圆角 + 流式光标） */
  isLastBlock: boolean
  /** 是否正在流式输出（仅最后一个块为 true） */
  streaming: boolean
}
