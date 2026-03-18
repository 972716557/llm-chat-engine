/**
 * 判断是否为 Markdown 标题行（H1–H6）：行首为 1–6 个 # 后跟空格
 */
function isHeadingLine(line: string): boolean {
  return /^#{1,6}\s/.test(line.trimStart())
}

/**
 * 判断是否为表格行：以 | 开头且至少包含两个 |
 */
function isTableRowLine(line: string): boolean {
  const t = line.trim()
  if (!t.startsWith('|')) return false
  return (t.match(/\|/g) ?? []).length >= 2
}

/**
 * 将 Markdown 文本拆分为独立的块（block）
 *
 * 拆分规则（优先级从高到低）：
 * 1. 围栏代码块（```...```）作为整体保留为一个块
 * 2. 代码块外，标题行（# / ## / ... / ###### ）单独成块或开启新块
 * 3. 代码块外，表格（| A | B | 及分隔行、数据行）整体保留为一个块
 * 4. 空行作为分隔符
 * 5. 连续的非空行（非标题、非表格）合并为一个块
 *
 * 这样每个块都是可独立渲染的 Markdown 片段，用于虚拟滚动的细粒度虚拟化。
 */
export function splitMarkdownBlocks(text: string): string[] {
  if (!text) return ['']

  const lines = text.split('\n')
  const blocks: string[] = []
  let currentLines: string[] = []
  let inCodeBlock = false

  const flush = () => {
    if (currentLines.length > 0) {
      blocks.push(currentLines.join('\n'))
      currentLines = []
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trimStart()

    // ----- 1. 围栏代码块 -----
    if (trimmed.startsWith('```')) {
      if (!inCodeBlock) {
        flush()
        inCodeBlock = true
        currentLines.push(line)
      } else {
        currentLines.push(line)
        blocks.push(currentLines.join('\n'))
        currentLines = []
        inCodeBlock = false
      }
      continue
    }

    if (inCodeBlock) {
      currentLines.push(line)
      continue
    }

    // ----- 代码块外部 -----
    if (line.trim() === '') {
      flush()
      continue
    }

    if (isHeadingLine(line)) {
      // ----- 2. 标题行：新块（标题单独一块，后续段落可与下一空行/标题/表格再分）-----
      flush()
      currentLines.push(line)
      continue
    }

    if (isTableRowLine(line)) {
      // ----- 3. 表格行：若当前不是表格块则先 flush 再开新块；否则续在当前块 -----
      const inTable = currentLines.length > 0 && isTableRowLine(currentLines[currentLines.length - 1])
      if (!inTable) {
        flush()
      }
      currentLines.push(line)
      continue
    }

    // ----- 普通行：若当前是表格块则表格结束，先 flush 再开新块；否则续在当前块 -----
    const wasTable = currentLines.length > 0 && isTableRowLine(currentLines[currentLines.length - 1])
    if (wasTable) {
      flush()
    }
    currentLines.push(line)
  }

  flush()
  return blocks.length > 0 ? blocks : ['']
}
