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
