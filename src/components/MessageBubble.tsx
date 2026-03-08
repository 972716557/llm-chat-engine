import { memo, useRef, useEffect } from 'react'
import type { VirtualBlock } from '../types'
import { useStreamInterceptor } from '../hooks/useStreamInterceptor'

interface MessageBubbleProps {
  block: VirtualBlock
  /** 虚拟列表中的索引，用于 data-index 属性 */
  index: number
  /** 注册 ResizeObserver 观察 */
  onObserve: (el: HTMLElement | null) => void
  /** 取消 ResizeObserver 观察 */
  onUnobserve: (el: HTMLElement | null) => void
}

/**
 * 单个块的渲染组件
 *
 * 一条消息可能由多个块组成，通过 isFirstBlock / isLastBlock
 * 控制角色标签、圆角、光标等视觉元素的显示。
 */
const MessageBubble = memo<MessageBubbleProps>(
  ({ block, index, onObserve, onUnobserve }) => {
    const elRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
      const el = elRef.current
      onObserve(el)
      return () => {
        onUnobserve(el)
      }
    }, [onObserve, onUnobserve])

    const html = useStreamInterceptor(block.content, block.streaming)

    const isUser = block.role === 'user'

    // 根据块在消息中的位置决定 CSS 类
    const positionClass =
      block.isFirstBlock && block.isLastBlock
        ? 'block-only'
        : block.isFirstBlock
          ? 'block-first'
          : block.isLastBlock
            ? 'block-last'
            : 'block-middle'

    return (
      <div
        ref={elRef}
        data-index={index}
        className={`message-bubble ${isUser ? 'message-user' : 'message-assistant'} ${positionClass}`}
      >
        {block.isFirstBlock && (
          <div className="message-role">{isUser ? '你' : 'AI'}</div>
        )}
        <div
          className="message-content"
          dangerouslySetInnerHTML={{ __html: html }}
        />
        {block.streaming && block.isLastBlock && <span className="streaming-cursor" />}
      </div>
    )
  },
  (prevProps, nextProps) => {
    return (
      prevProps.block.content === nextProps.block.content &&
      prevProps.block.streaming === nextProps.block.streaming &&
      prevProps.block.isFirstBlock === nextProps.block.isFirstBlock &&
      prevProps.block.isLastBlock === nextProps.block.isLastBlock &&
      prevProps.index === nextProps.index
    )
  }
)

MessageBubble.displayName = 'MessageBubble'

export default MessageBubble
