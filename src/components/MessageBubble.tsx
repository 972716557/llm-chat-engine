import { memo, useRef, useEffect } from 'react'
import type { ChatMessage } from '../types'
import { useStreamInterceptor } from '../hooks/useStreamInterceptor'

interface MessageBubbleProps {
  message: ChatMessage
  /** 虚拟列表中的索引，用于 data-index 属性 */
  index: number
  /** 注册 ResizeObserver 观察 */
  onObserve: (el: HTMLElement | null) => void
  /** 取消 ResizeObserver 观察 */
  onUnobserve: (el: HTMLElement | null) => void
}

/**
 * 单条消息气泡组件
 *
 * 使用 React.memo 包裹，切断父组件更新时对历史（非流式）消息的不必要重绘。
 * memo 的比较逻辑：只在 message.content 或 message.streaming 变化时才重新渲染。
 */
const MessageBubble = memo<MessageBubbleProps>(
  ({ message, index, onObserve, onUnobserve }) => {
    const elRef = useRef<HTMLDivElement>(null)

    // 挂载时注册观察，卸载时取消观察
    useEffect(() => {
      const el = elRef.current
      onObserve(el)
      return () => {
        onUnobserve(el)
      }
    }, [onObserve, onUnobserve])

    // 使用流式拦截器将 markdown 转为安全的 HTML
    const html = useStreamInterceptor(message.content, !!message.streaming)

    const isUser = message.role === 'user'

    return (
      <div
        ref={elRef}
        data-index={index}
        className={`message-bubble ${isUser ? 'message-user' : 'message-assistant'}`}
      >
        <div className="message-role">{isUser ? '你' : 'AI'}</div>
        <div
          className="message-content"
          dangerouslySetInnerHTML={{ __html: html }}
        />
        {message.streaming && <span className="streaming-cursor" />}
      </div>
    )
  },
  (prevProps, nextProps) => {
    // 自定义比较：只在内容或流式状态变化时才重绘
    return (
      prevProps.message.content === nextProps.message.content &&
      prevProps.message.streaming === nextProps.message.streaming &&
      prevProps.index === nextProps.index
    )
  }
)

MessageBubble.displayName = 'MessageBubble'

export default MessageBubble
