/**
 * Markdown 流式状态机拦截器
 *
 * 核心思路：
 * SSE 流式传输中，markdown 文本是逐字到达的，任意时刻文本都可能处于
 * "半开"状态——比如只收到了 ``` 的开头却没有结尾，或者 ** 只出现了一个。
 * 如果直接把这种残缺文本交给 markdown-it 解析，会产生错误的 DOM 结构，
 * 导致 UI 剧烈闪烁。
 *
 * 本拦截器的做法是：
 * 1. 扫描原始文本，用栈结构追踪所有未闭合的 markdown 语法标记
 * 2. 在原始文本的副本末尾，按照后进先出的顺序补齐闭合标记
 * 3. 把补齐后的文本交给 markdown-it，得到稳定的 HTML 输出
 * 4. 绝不修改原始 SSE 接收数据，只在渲染层面做补齐
 */

/** 栈中的标记类型 */
type MarkType = 'codeBlock' | 'inlineCode' | 'bold' | 'italic' | 'blockquote' | 'heading' | 'table'

interface StackEntry {
  type: MarkType
  /** 用于闭合的字符串 */
  closeTag: string
}

/**
 * 判断是否为 Markdown 表格分隔行（|---|---|）
 */
function isTableSeparatorLine(line: string): boolean {
  const t = line.trim()
  if (!t.startsWith('|') || !t.endsWith('|')) return false
  return /^\|[\s\-:|]+\|$/.test(t)
}

/**
 * 判断是否为表格行（至少包含两个 |）
 */
function isTableRowLine(line: string): boolean {
  const t = line.trim()
  if (!t.startsWith('|')) return false
  const pipeCount = (t.match(/\|/g) ?? []).length
  return pipeCount >= 2
}

/**
 * 根据表头行生成分隔行（如 | A | B | -> |---|---|）
 */
function makeTableSeparatorRow(headerRow: string): string {
  const pipeCount = (headerRow.trim().match(/\|/g) ?? []).length
  const columns = Math.max(1, pipeCount - 1)
  return '\n|' + '---|'.repeat(columns)
}

/**
 * 扫描 markdown 文本，返回需要补齐的闭合标记
 *
 * 状态机处理顺序（优先级从高到低）：
 * 1. ``` 围栏代码块（最高优先级，内部所有 markdown 语法失效）
 * 2. ` 行内代码（内部 markdown 语法失效）
 * 3. ** 粗体
 * 4. * 斜体（注意与粗体的 ** 区分）
 * 5. > 引用块（按行处理，未换行则补 \n）
 * 6. # / ## 标题 H1/H2（按行处理，未换行则补 \n）
 * 7. 表格（缺分隔行则补分隔行，未换行则补 \n）
 */
export function analyzeUnclosedMarks(text: string): StackEntry[] {
  const stack: StackEntry[] = []

  // ===== 第一步：处理围栏代码块 =====
  // 围栏代码块优先级最高，内部所有语法都失效
  let inCodeBlock = false
  const lines = text.split('\n')
  let textAfterLastCodeFence = text // 如果在代码块内，这个值不重要

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart()
    if (trimmed.startsWith('```')) {
      if (!inCodeBlock) {
        // 进入代码块
        inCodeBlock = true
        // 记住代码块开始后的文本部分（用于后续分析）
        textAfterLastCodeFence = ''
      } else {
        // 离开代码块
        inCodeBlock = false
        // 更新代码块结束后的文本
        textAfterLastCodeFence = lines.slice(i + 1).join('\n')
      }
    }
  }

  // 如果当前处于未闭合的代码块内，直接返回代码块闭合标记
  // 代码块内部不需要处理任何其他 markdown 语法
  if (inCodeBlock) {
    stack.push({ type: 'codeBlock', closeTag: '\n```' })
    return stack
  }

  // ===== 第二步：在代码块之外的文本中处理行内语法 =====
  // 只分析代码块之外的文本部分
  const safeText = textAfterLastCodeFence

  // 处理行内代码 ` ... `
  // 需要先识别行内代码，因为行内代码内部的 * 和 ** 不应被当做语法
  let inInlineCode = false
  // 移除行内代码中的内容，用占位符替换，以避免干扰 bold/italic 的检测
  let cleanText = ''
  for (let i = 0; i < safeText.length; i++) {
    const ch = safeText[i]
    // 检查是不是 ``` (三个反引号，但不在代码块层面——这里已经处理过代码块了)
    // 在行内层面，只处理单个反引号
    if (ch === '`') {
      if (!inInlineCode) {
        inInlineCode = true
        cleanText += ch
      } else {
        inInlineCode = false
        cleanText += ch
      }
    } else if (inInlineCode) {
      // 在行内代码中，用空格替换内容，保持长度一致
      cleanText += ' '
    } else {
      cleanText += ch
    }
  }

  // 如果行内代码未闭合
  if (inInlineCode) {
    stack.push({ type: 'inlineCode', closeTag: '`' })
    // 行内代码内部不处理其他语法
    return stack
  }

  // ===== 第三步：在清理后的文本中处理 bold 和 italic =====
  // 使用清理后的文本（行内代码内容已被替换为空格）
  let boldOpen = false
  let italicOpen = false

  for (let i = 0; i < cleanText.length; i++) {
    // 检查 ** （粗体）
    if (cleanText[i] === '*' && i + 1 < cleanText.length && cleanText[i + 1] === '*') {
      if (!boldOpen) {
        boldOpen = true
      } else {
        boldOpen = false
      }
      i++ // 跳过第二个 *
      continue
    }

    // 检查单个 * （斜体）—— 但要排除 ** 的情况
    if (cleanText[i] === '*') {
      // 确认前一个字符不是 *，后一个字符也不是 *
      const prevIsAsterisk = i > 0 && cleanText[i - 1] === '*'
      const nextIsAsterisk = i + 1 < cleanText.length && cleanText[i + 1] === '*'
      if (!prevIsAsterisk && !nextIsAsterisk) {
        if (!italicOpen) {
          italicOpen = true
        } else {
          italicOpen = false
        }
      }
    }
  }

  // 按照后进先出原则压栈（先检测到的后闭合）
  // 但这里我们按检测顺序推入栈，返回时会逆序使用
  if (italicOpen) {
    stack.push({ type: 'italic', closeTag: '*' })
  }
  if (boldOpen) {
    stack.push({ type: 'bold', closeTag: '**' })
  }

  // ===== 第四步：块级语法（引用、标题、表格）=====
  // 仅检查“最后一行”是否未以换行结束，或表格是否缺分隔行
  const safeLines = safeText.split('\n')
  const endsWithNewline = safeText.length > 0 && safeText.endsWith('\n')
  const lastLine = safeLines.length > 0 ? safeLines[safeLines.length - 1] : ''
  const lastLineTrimmed = lastLine.trimStart()

  // 5. 引用块：最后一行以 > 开头且未换行 → 补 \n
  if (!endsWithNewline && lastLineTrimmed.startsWith('>')) {
    stack.push({ type: 'blockquote', closeTag: '\n' })
  }

  // 6. 标题 H1/H2：最后一行以 # 或 ## 开头（# 后跟空格）且未换行 → 补 \n
  const headingMatch = lastLineTrimmed.match(/^#{1,6}\s/)
  if (!endsWithNewline && headingMatch) {
    stack.push({ type: 'heading', closeTag: '\n' })
  }

  // 7. 表格：有表头行但无分隔行 → 补分隔行；最后一行是表格行且未换行 → 补 \n
  let sawTableHeader = false
  let sawTableSeparator = false
  let firstTableHeaderRow = ''
  for (let i = 0; i < safeLines.length; i++) {
    const line = safeLines[i]
    if (isTableSeparatorLine(line)) {
      sawTableSeparator = true
    } else if (isTableRowLine(line)) {
      if (!sawTableHeader) {
        sawTableHeader = true
        firstTableHeaderRow = line
      }
    } else {
      sawTableHeader = false
      sawTableSeparator = false
      firstTableHeaderRow = ''
    }
  }
  // 先压入 \n，再压入分隔行，这样 LIFO 时先补分隔行再补 \n
  if (!endsWithNewline && isTableRowLine(lastLine)) {
    stack.push({ type: 'table', closeTag: '\n' })
  }
  if (sawTableHeader && !sawTableSeparator && firstTableHeaderRow) {
    stack.push({ type: 'table', closeTag: makeTableSeparatorRow(firstTableHeaderRow) })
  }

  return stack
}

/**
 * 核心导出函数：对残缺的 markdown 文本进行闭合补齐
 *
 * @param rawText - SSE 流式接收到的原始（可能残缺的）markdown 文本
 * @returns 补齐闭合标记后的完整 markdown 文本（仅用于渲染，不修改原始数据）
 */
export function completeMarkdown(rawText: string): string {
  const unclosed = analyzeUnclosedMarks(rawText)

  if (unclosed.length === 0) {
    return rawText
  }

  // 后进先出：栈顶的标记先闭合
  let suffix = ''
  for (let i = unclosed.length - 1; i >= 0; i--) {
    suffix += unclosed[i].closeTag
  }

  return rawText + suffix
}
