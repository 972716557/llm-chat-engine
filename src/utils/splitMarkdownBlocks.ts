/**
 * 将 Markdown 文本拆分为独立的块（block）
 *
 * 拆分规则：
 * 1. 围栏代码块（```...```）作为整体保留为一个块
 * 2. 代码块之外，以空行为分隔符切分块
 * 3. 连续的非空行合并为一个块
 *
 * 这样每个块都是一个可独立渲染的 Markdown 片段，
 * 用于虚拟滚动的细粒度虚拟化。
 */
export function splitMarkdownBlocks(text: string): string[] {
  if (!text) return ['']

  const lines = text.split('\n')
  const blocks: string[] = []
  let currentLines: string[] = []
  let inCodeBlock = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trimStart()

    if (trimmed.startsWith('```')) {
      if (!inCodeBlock) {
        // 遇到代码块开头：先把之前积累的普通行提交为一个块
        if (currentLines.length > 0) {
          blocks.push(currentLines.join('\n'))
          currentLines = []
        }
        inCodeBlock = true
        currentLines.push(line)
      } else {
        // 代码块结束：把整个代码块（包括围栏）作为一个块
        currentLines.push(line)
        blocks.push(currentLines.join('\n'))
        currentLines = []
        inCodeBlock = false
      }
      continue
    }

    if (inCodeBlock) {
      // 代码块内部，直接累积
      currentLines.push(line)
      continue
    }

    // 代码块外部：空行作为分隔符
    if (line.trim() === '') {
      if (currentLines.length > 0) {
        blocks.push(currentLines.join('\n'))
        currentLines = []
      }
    } else {
      currentLines.push(line)
    }
  }

  // 收尾：处理剩余行
  if (currentLines.length > 0) {
    blocks.push(currentLines.join('\n'))
  }

  return blocks.length > 0 ? blocks : ['']
}
