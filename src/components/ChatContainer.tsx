import { useState, useCallback, useRef, useEffect } from 'react'
import type { ChatMessage } from '../types'
import { useDynamicVirtualList } from '../hooks/useDynamicVirtualList'
import MessageBubble from './MessageBubble'

/** 模拟 SSE 流式输出的 mock 数据 */
const MOCK_RESPONSES = [
  `# 你好！这是一个标题

这是一段普通文本。让我给你展示一些 **Markdown** 功能。

## 代码示例

\`\`\`typescript
function fibonacci(n: number): number {
  if (n <= 1) return n
  return fibonacci(n - 1) + fibonacci(n - 2)
}

console.log(fibonacci(10)) // 55
\`\`\`

## 列表

- 第一项：*斜体文本*
- 第二项：**粗体文本**
- 第三项：\`行内代码\`

> 这是一段引用文本。
> 引用可以有多行。

最后是一个[链接](https://example.com)。`,

  `## 关于虚拟滚动

虚拟滚动的核心思想是 **只渲染视口内可见的元素**，而非渲染整个长列表。

### 关键技术点

1. **位置计算**：使用 \`positions\` 数组记录每个条目的位置
2. **动态测量**：通过 \`ResizeObserver\` 精确测量实际高度
3. **异步更新**：利用 \`requestIdleCallback\` 避免阻塞主线程

\`\`\`javascript
// 二分查找示例
function findStartIndex(scrollTop, positions) {
  let low = 0, high = positions.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (positions[mid].bottom <= scrollTop) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return low;
}
\`\`\`

这种方案可以轻松支撑 **1000+** 条消息的流畅滚动。`,

  `### 流式 Markdown 的挑战

当 LLM 通过 SSE 逐字输出时，会出现这些情况：

1. 收到 \`\`\` 但还没收到结束标记
2. 收到 \`**加\` 但 bold 标记还没闭合
3. 收到 \`> 引用\` 但下一行还在传输中

**解决方案：状态机拦截器**

我们使用一个栈结构来追踪未闭合的标记：

\`\`\`
输入: "hello **world"
栈:   [{ type: 'bold', closeTag: '**' }]
补齐: "hello **world**"
\`\`\`

这样 \`markdown-it\` 就能得到完整的输入，渲染出稳定的 DOM 结构。`,
]

let messageIdCounter = 0
function nextId() {
  return `msg-${++messageIdCounter}`
}

/**
 * 聊天容器主组件
 *
 * 管理双状态数据模型：
 * - 历史消息（冷数据）：已完成输出的消息，不会再变化
 * - 当前流式消息（热数据）：正在通过 SSE 输出的消息，高频更新
 *
 * 冷热分离避免流式输出时引发全量重绘。
 */
export default function ChatContainer() {
  // ===== 冷数据：已完成的历史消息 =====
  const [historyMessages, setHistoryMessages] = useState<ChatMessage[]>([])

  // ===== 热数据：当前正在流式输出的消息 =====
  const [streamingMessage, setStreamingMessage] = useState<ChatMessage | null>(null)

  // ===== 输入框内容 =====
  const [inputText, setInputText] = useState('')

  // ===== 流式输出计时器 ref =====
  const streamTimerRef = useRef<number | null>(null)

  // ===== 容器高度（简化处理，固定值） =====
  const containerHeight = 600

  // ===== 合并所有消息用于虚拟列表 =====
  const allMessages = streamingMessage
    ? [...historyMessages, streamingMessage]
    : historyMessages

  // ===== 虚拟列表 Hook =====
  const {
    scrollContainerRef,
    totalHeight,
    visibleRange,
    getItemStyle,
    observeElement,
    unobserveElement,
    handleScroll,
    scrollToBottom,
  } = useDynamicVirtualList(allMessages.length, containerHeight)

  // ===== 模拟 SSE 流式输出 =====
  const simulateStream = useCallback((content: string) => {
    const msgId = nextId()
    let charIndex = 0

    // 创建初始的流式消息
    setStreamingMessage({
      id: msgId,
      role: 'assistant',
      content: '',
      streaming: true,
    })

    // 每 20ms 追加一个字符，模拟 SSE token 流
    const timer = window.setInterval(() => {
      charIndex++

      if (charIndex >= content.length) {
        // 流式输出结束
        window.clearInterval(timer)
        streamTimerRef.current = null

        // 将完成的消息从"热数据"转移到"冷数据"
        const finalMessage: ChatMessage = {
          id: msgId,
          role: 'assistant',
          content,
          streaming: false,
        }
        setStreamingMessage(null)
        setHistoryMessages((prev) => [...prev, finalMessage])
        return
      }

      // 更新流式消息内容（只更新热数据，不触发冷数据重绘）
      setStreamingMessage({
        id: msgId,
        role: 'assistant',
        content: content.slice(0, charIndex),
        streaming: true,
      })
    }, 20)

    streamTimerRef.current = timer
  }, [])

  // ===== 发送消息 =====
  const handleSend = useCallback(() => {
    const text = inputText.trim()
    if (!text || streamTimerRef.current) return

    // 添加用户消息到历史
    const userMsg: ChatMessage = {
      id: nextId(),
      role: 'user',
      content: text,
      streaming: false,
    }
    setHistoryMessages((prev) => [...prev, userMsg])
    setInputText('')

    // 随机选择一个 mock 回复并开始流式输出
    const mockIndex = Math.floor(Math.random() * MOCK_RESPONSES.length)
    setTimeout(() => {
      simulateStream(MOCK_RESPONSES[mockIndex])
    }, 300)
  }, [inputText, simulateStream])

  // ===== 批量生成测试消息（用于压力测试） =====
  const handleBulkGenerate = useCallback(() => {
    const bulk: ChatMessage[] = []
    for (let i = 0; i < 100; i++) {
      bulk.push({
        id: nextId(),
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: i % 2 === 0
          ? `这是第 ${Math.floor(i / 2) + 1} 轮对话的用户消息。`
          : MOCK_RESPONSES[i % MOCK_RESPONSES.length],
        streaming: false,
      })
    }
    setHistoryMessages((prev) => [...prev, ...bulk])
    // 生成后滚动到底部
    setTimeout(scrollToBottom, 100)
  }, [scrollToBottom])

  // ===== 组件卸载时清理 =====
  useEffect(() => {
    return () => {
      if (streamTimerRef.current) {
        window.clearInterval(streamTimerRef.current)
      }
    }
  }, [])

  // ===== 渲染可见区域的消息 =====
  const { startIndex, endIndex } = visibleRange
  const visibleItems = []
  for (let i = startIndex; i <= endIndex && i < allMessages.length; i++) {
    visibleItems.push(
      <div key={allMessages[i].id} style={getItemStyle(i)}>
        <MessageBubble
          message={allMessages[i]}
          index={i}
          onObserve={observeElement}
          onUnobserve={unobserveElement}
        />
      </div>
    )
  }

  return (
    <div className="chat-container">
      <div className="chat-header">
        <h2>LLM 流式对话引擎</h2>
        <button onClick={handleBulkGenerate} className="btn-bulk">
          生成 100 条测试消息
        </button>
        <span className="message-count">
          共 {allMessages.length} 条消息 | 渲染 {visibleItems.length} 个 DOM 节点
        </span>
      </div>

      {/* 虚拟滚动容器 */}
      <div
        ref={scrollContainerRef}
        className="scroll-container"
        style={{ height: containerHeight }}
        onScroll={handleScroll}
      >
        {/* 占位元素，撑开滚动高度 */}
        <div className="scroll-phantom" style={{ height: totalHeight }}>
          {visibleItems}
        </div>
      </div>

      {/* 输入区域 */}
      <div className="chat-input-area">
        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder="输入消息..."
          className="chat-input"
          disabled={!!streamTimerRef.current}
        />
        <button
          onClick={handleSend}
          className="btn-send"
          disabled={!!streamTimerRef.current}
        >
          发送
        </button>
      </div>
    </div>
  )
}
