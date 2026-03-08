# LLM Chat Engine

一个高性能的 LLM 流式对话渲染引擎，专注于解决大规模聊天消息的虚拟滚动与流式 Markdown 渲染问题。

## 核心特性

### 块级虚拟滚动

传统虚拟滚动以"整条消息"为粒度，当 LLM 返回超长回复时，单条消息的 DOM 可能几千像素，虚拟化形同虚设。本项目将虚拟化粒度下沉到 **Markdown 块级别**（段落、代码块、标题、引用等），确保即使单条消息极长，也只渲染视口内可见的几个块。

```
视口 600px
├── block[7]  "## 二分查找"       ← 可见，渲染
├── block[8]  "```ts\ncode\n```"   ← 可见，渲染
├── block[9]  "这种方案..."        ← 可见，渲染
└── block[10-25] ...               ← 不可见，不渲染
```

### 滚动性能优化

- **rAF 节流**：滚动事件合并为每帧一次处理
- **按需渲染**：`scrollTop` 存储在 `useRef` 中，只有可见范围（startIndex/endIndex）变化时才触发 React 重渲染
- **滚动补偿**：当视口上方的块高度被 ResizeObserver 修正时，自动调整 `scrollTop` 防止内容跳动
- **rIC 时间分片**：高度变更的级联更新放在 `requestIdleCallback` 中异步执行，避免阻塞主线程

### 流式 Markdown 渲染

- **状态机拦截器**：通过栈结构追踪未闭合的 Markdown 标记（代码块、粗体、斜体等），在渲染前自动补齐，消除流式输出时的 DOM 闪烁
- **冷热数据分离**：历史消息（冷数据）与当前流式消息（热数据）独立管理，流式更新不触发历史消息的重绘

## 技术栈

- React 19 + TypeScript
- Vite
- markdown-it
- Vitest

## 快速开始

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 构建
npm run build

# 运行测试
npm run test
```

## 项目结构

```
src/
├── components/
│   ├── ChatContainer.tsx      # 聊天容器，管理消息状态与块级展平
│   └── MessageBubble.tsx      # 单个块的渲染组件，处理视觉分组
├── hooks/
│   ├── useDynamicVirtualList.ts  # 虚拟列表引擎（核心）
│   └── useStreamInterceptor.ts   # 流式 Markdown → HTML 转换
├── utils/
│   ├── splitMarkdownBlocks.ts    # Markdown 文本按块拆分
│   └── streamInterceptor.ts      # Markdown 未闭合标记补齐
└── types.ts                      # 类型定义
```

## 架构概览

```
消息列表 (ChatMessage[])
    ↓ splitMarkdownBlocks
块列表 (VirtualBlock[])
    ↓ useDynamicVirtualList
positions[] ←── ResizeObserver 测量真实高度
    ↓                  ↓
二分查找 O(log n)    rIC 级联更新 + 滚动补偿
    ↓
visibleRange { start, end }
    ↓
只渲染可见块 DOM（绝对定位）
```
