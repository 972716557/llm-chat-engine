import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import type { ChatMessage, VirtualBlock } from '../types'
import { useDynamicVirtualList } from '../hooks/useDynamicVirtualList'
import { splitMarkdownBlocks } from '../utils/splitMarkdownBlocks'
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

  `# 深入理解 React 虚拟化长列表

在现代 Web 应用中，处理大规模数据列表是一个常见的挑战。当列表包含成千上万个条目时，直接渲染所有 DOM 节点会严重影响性能。

## 为什么需要虚拟化？

浏览器的 DOM 操作是昂贵的。每个 DOM 节点都需要内存来存储其属性、样式和事件监听器。当页面上有过多的 DOM 节点时：

- **内存占用急剧增加**：每个节点约占 0.5-1KB 内存
- **布局计算变慢**：浏览器需要计算每个节点的位置
- **重绘开销增大**：滚动时需要重新绘制大量像素
- **事件处理变慢**：事件冒泡路径变长

## 虚拟化的核心原理

虚拟化的核心思想很简单：**只渲染用户能看到的部分**。

\`\`\`
┌─────────────────────┐
│    不可见区域 (top)    │  ← 不渲染 DOM
│                      │
├──────────────────────┤
│  ┌──────────────┐    │
│  │ 缓冲区 (3条)  │    │  ← 预渲染，防止快速滚动白屏
│  ├──────────────┤    │
│  │              │    │
│  │  视口可见区域  │    │  ← 用户实际看到的内容
│  │  (约 8-12 条) │    │
│  │              │    │
│  ├──────────────┤    │
│  │ 缓冲区 (3条)  │    │  ← 预渲染
│  └──────────────┘    │
├──────────────────────┤
│   不可见区域 (bottom)  │  ← 不渲染 DOM
│                      │
└──────────────────────┘
\`\`\`

## 位置管理

每个条目在 \`positions\` 数组中维护三个关键属性：

\`\`\`typescript
interface ItemPosition {
  index: number    // 条目索引
  top: number      // 距顶部偏移
  height: number   // 条目高度
  bottom: number   // top + height
}
\`\`\`

初始时所有条目使用预估高度（如 80px），形成一个连续的坐标轴。随着 DOM 渲染，\`ResizeObserver\` 会测量真实高度并更新。

## 二分查找定位

当用户滚动时，需要快速找到"视口顶部对应的是哪个条目"。由于 \`positions\` 数组的 \`bottom\` 值是单调递增的，可以用二分查找在 O(log n) 时间内完成定位：

\`\`\`typescript
function findStartIndex(scrollTop: number): number {
  let low = 0, high = positions.length - 1
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    if (positions[mid].bottom <= scrollTop) {
      low = mid + 1
    } else if (positions[mid].top > scrollTop) {
      high = mid - 1
    } else {
      return mid  // scrollTop 落在这个条目的范围内
    }
  }
  return low
}
\`\`\`

## 动态高度测量

聊天消息的高度是不可预测的——一条消息可能是简短的"好的"，也可能是包含代码块、列表、图片的长文本。我们使用 \`ResizeObserver\` 来精确测量每个条目的实际高度：

\`\`\`typescript
const observer = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const index = parseInt(entry.target.dataset.index)
    const newHeight = entry.contentRect.height

    if (Math.abs(positions[index].height - newHeight) > 0.5) {
      // 高度变化超过阈值，入队等待更新
      heightDiffQueue.push({ index, newHeight })
      scheduleLayoutUpdate()
    }
  }
})
\`\`\`

## 异步批量更新

当某个条目的高度发生变化时，它后面所有条目的 \`top\` 和 \`bottom\` 都需要重新计算。如果立即同步执行，可能会阻塞主线程导致卡顿。

我们使用 \`requestIdleCallback\` 在浏览器空闲时处理这些更新，并通过时间分片避免长时间阻塞：

\`\`\`typescript
requestIdleCallback((deadline) => {
  let i = minChangedIndex
  while (i < positions.length) {
    if (deadline.timeRemaining() <= 0) {
      // 时间片用完，下一帧继续
      scheduleNextBatch(i)
      break
    }
    positions[i].top = positions[i-1].bottom
    positions[i].bottom = positions[i].top + positions[i].height
    i++
  }
  triggerRerender()
}, { timeout: 100 })
\`\`\`

## 底部锚定

在聊天场景中，用户通常希望看到最新消息。我们通过监听滚动位置来实现自动底部锚定：

- 当用户位于底部附近（距底部 < 50px）时，新消息到来会自动滚动
- 当用户手动向上滚动时，暂停自动滚动，不打断阅读

## 总结

虚拟化技术让我们能够在保持流畅体验的同时，处理任意数量的聊天消息。关键在于：

1. **只渲染可见区域** — 控制 DOM 节点数量
2. **动态测量高度** — 适应不同内容的消息
3. **异步批量更新** — 避免阻塞主线程
4. **智能底部锚定** — 兼顾自动滚动和手动浏览

这些技术组合在一起，构成了一个高性能的聊天消息渲染引擎。`,
]

let messageIdCounter = 0
function nextId() {
  return `msg-${++messageIdCounter}`
}

/**
 * 将消息列表展平为虚拟块列表
 *
 * 每条消息根据 Markdown 结构拆分为多个块，
 * 短消息保持为单块，长消息拆分为多块以支持块级虚拟化。
 */
function flattenToBlocks(messages: ChatMessage[]): VirtualBlock[] {
  const blocks: VirtualBlock[] = []

  for (const msg of messages) {
    const parts = splitMarkdownBlocks(msg.content)

    for (let i = 0; i < parts.length; i++) {
      blocks.push({
        id: `${msg.id}-b${i}`,
        messageId: msg.id,
        content: parts[i],
        role: msg.role,
        isFirstBlock: i === 0,
        isLastBlock: i === parts.length - 1,
        streaming: !!msg.streaming && i === parts.length - 1,
      })
    }
  }

  return blocks
}

/**
 * 聊天容器主组件
 *
 * 管理双状态数据模型：
 * - 历史消息（冷数据）：已完成输出的消息，不会再变化
 * - 当前流式消息（热数据）：正在通过 SSE 输出的消息，高频更新
 *
 * 虚拟化粒度为块级别（block-level），一条长消息会被拆分为多个块，
 * 每个块独立参与虚拟滚动，确保超长消息也能被有效虚拟化。
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

  // ===== 缓存历史消息的块列表（冷数据，只在消息完成时变化） =====
  const historyBlocks = useMemo(
    () => flattenToBlocks(historyMessages),
    [historyMessages]
  )

  // ===== 合并所有块：历史块 + 流式消息的块（每条消息可能对应多块，虚拟列表按块区分高度）=====
  const allBlocks = useMemo(() => {
    if (!streamingMessage) return historyBlocks
    const streamBlocks = flattenToBlocks([streamingMessage])
    return [...historyBlocks, ...streamBlocks]
  }, [historyBlocks, streamingMessage])

  // ===== 虚拟列表：条目 = 块，每个块独立高度；长消息已拆成多块，故按块虚拟滚动即可 =====
  const {
    scrollContainerRef,
    totalHeight,
    visibleRange,
    getItemStyle,
    observeElement,
    unobserveElement,
    handleScroll,
    scrollToBottom,
  } = useDynamicVirtualList(allBlocks.length, containerHeight)

  // ===== 模拟 SSE 流式输出 =====
  const simulateStream = useCallback((content: string) => {
    const msgId = nextId()
    let charIndex = 0

    setStreamingMessage({
      id: msgId,
      role: 'assistant',
      content: '',
      streaming: true,
    })

    const timer = window.setInterval(() => {
      charIndex++

      if (charIndex >= content.length) {
        window.clearInterval(timer)
        streamTimerRef.current = null

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

    const userMsg: ChatMessage = {
      id: nextId(),
      role: 'user',
      content: text,
      streaming: false,
    }
    setHistoryMessages((prev) => [...prev, userMsg])
    setInputText('')

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

  // ===== 统计消息数量（用于显示） =====
  const messageCount = historyMessages.length + (streamingMessage ? 1 : 0)

  // ===== 渲染可见区域的块 =====
  const { startIndex, endIndex } = visibleRange
  const visibleItems = []
  for (let i = startIndex; i <= endIndex && i < allBlocks.length; i++) {
    visibleItems.push(
      <div key={allBlocks[i].id} style={getItemStyle(i)}>
        <MessageBubble
          block={allBlocks[i]}
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
          共 {messageCount} 条消息 ({allBlocks.length} 个块) | 渲染 {visibleItems.length} 个 DOM 节点
        </span>
      </div>

      {/* 虚拟滚动容器 */}
      <div
        ref={scrollContainerRef}
        className="scroll-container"
        style={{ height: containerHeight }}
        onScroll={handleScroll}
      >
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
