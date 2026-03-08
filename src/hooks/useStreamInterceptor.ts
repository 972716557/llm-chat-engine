import { useMemo } from 'react'
import MarkdownIt from 'markdown-it'
import { completeMarkdown } from '../utils/streamInterceptor'

/**
 * useStreamInterceptor Hook
 *
 * 将流式 markdown 文本转换为安全的 HTML，供 React 组件渲染。
 * 内部流程：
 * 1. 调用 completeMarkdown 补齐未闭合的 markdown 标记
 * 2. 调用 markdown-it 将补齐后的文本转为 HTML
 *
 * @param rawText - SSE 流式接收到的原始 markdown 文本
 * @param isStreaming - 是否仍在流式输出中（完成后不需要补齐）
 * @returns 渲染用的 HTML 字符串
 */

// 单例 markdown-it 实例，避免重复创建
const md = new MarkdownIt({
  html: false,        // 禁用 HTML 标签（安全考虑）
  linkify: true,      // 自动识别链接
  typographer: true,  // 启用排版优化
  breaks: true,       // 将换行符转为 <br>
})

export function useStreamInterceptor(rawText: string, isStreaming: boolean): string {
  const html = useMemo(() => {
    if (!rawText) return ''

    // 流式输出中：先补齐再渲染；输出完成后：直接渲染
    const textToRender = isStreaming ? completeMarkdown(rawText) : rawText
    return md.render(textToRender)
  }, [rawText, isStreaming])

  return html
}
