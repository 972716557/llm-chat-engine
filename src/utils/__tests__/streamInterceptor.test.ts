import { describe, it, expect } from 'vitest'
import { analyzeUnclosedMarks, completeMarkdown } from '../streamInterceptor'

describe('streamInterceptor - analyzeUnclosedMarks', () => {
  // ===== 围栏代码块测试 =====
  describe('围栏代码块 (```)', () => {
    it('检测未闭合的代码块', () => {
      const result = analyzeUnclosedMarks('hello\n```js\nconst x = 1')
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('codeBlock')
    })

    it('已闭合的代码块不返回标记', () => {
      const result = analyzeUnclosedMarks('hello\n```js\nconst x = 1\n```\nworld')
      expect(result).toHaveLength(0)
    })

    it('多个代码块，最后一个未闭合', () => {
      const result = analyzeUnclosedMarks(
        '```\nblock1\n```\ntext\n```python\nprint("hi")'
      )
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('codeBlock')
    })

    it('代码块内的 ** 和 * 不应被检测为未闭合标记', () => {
      const result = analyzeUnclosedMarks('```\n**bold** and *italic*\n```')
      expect(result).toHaveLength(0)
    })

    it('未闭合代码块内有 ** 时只返回 codeBlock', () => {
      const result = analyzeUnclosedMarks('```\n**bold text')
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('codeBlock')
    })
  })

  // ===== 行内代码测试 =====
  describe('行内代码 (`)', () => {
    it('检测未闭合的行内代码', () => {
      const result = analyzeUnclosedMarks('hello `world')
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('inlineCode')
    })

    it('已闭合的行内代码不返回标记', () => {
      const result = analyzeUnclosedMarks('hello `world` foo')
      expect(result).toHaveLength(0)
    })

    it('未闭合行内代码内的 ** 不应被检测', () => {
      const result = analyzeUnclosedMarks('hello `**bold')
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('inlineCode')
    })
  })

  // ===== 粗体测试 =====
  describe('粗体 (**)', () => {
    it('检测未闭合的粗体', () => {
      const result = analyzeUnclosedMarks('hello **world')
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('bold')
    })

    it('已闭合的粗体不返回标记', () => {
      const result = analyzeUnclosedMarks('hello **world** foo')
      expect(result).toHaveLength(0)
    })

    it('多个粗体，一个未闭合', () => {
      const result = analyzeUnclosedMarks('**a** and **b')
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('bold')
    })
  })

  // ===== 斜体测试 =====
  describe('斜体 (*)', () => {
    it('检测未闭合的斜体', () => {
      const result = analyzeUnclosedMarks('hello *world')
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('italic')
    })

    it('已闭合的斜体不返回标记', () => {
      const result = analyzeUnclosedMarks('hello *world* foo')
      expect(result).toHaveLength(0)
    })
  })

  // ===== 复合情况 =====
  describe('复合场景', () => {
    it('粗体和斜体同时未闭合', () => {
      const result = analyzeUnclosedMarks('hello **bold *italic')
      const types = result.map((r) => r.type)
      expect(types).toContain('bold')
      expect(types).toContain('italic')
    })

    it('空字符串不返回标记', () => {
      const result = analyzeUnclosedMarks('')
      expect(result).toHaveLength(0)
    })

    it('纯文本不返回标记', () => {
      const result = analyzeUnclosedMarks('hello world foo bar')
      expect(result).toHaveLength(0)
    })
  })
})

describe('streamInterceptor - completeMarkdown', () => {
  it('补齐未闭合的代码块', () => {
    const input = 'text\n```js\nconst x = 1'
    const result = completeMarkdown(input)
    expect(result).toBe(input + '\n```')
  })

  it('补齐未闭合的粗体', () => {
    const input = 'hello **world'
    const result = completeMarkdown(input)
    expect(result).toBe('hello **world**')
  })

  it('补齐未闭合的斜体', () => {
    const input = 'hello *world'
    const result = completeMarkdown(input)
    expect(result).toBe('hello *world*')
  })

  it('补齐未闭合的行内代码', () => {
    const input = 'hello `code'
    const result = completeMarkdown(input)
    expect(result).toBe('hello `code`')
  })

  it('已完整的文本不做修改', () => {
    const input = 'hello **world** and *foo*'
    const result = completeMarkdown(input)
    expect(result).toBe(input)
  })

  it('渐进式流式输入测试：逐字添加代码块', () => {
    // 模拟 SSE 逐字到达的过程
    const fullText = '```js\nconst x = 1\n```'
    const steps = [
      { input: '`', expected: '``' },        // 单个反引号 -> 补齐行内代码
      { input: '``', expected: '``' },         // 两个反引号 -> 无需补齐
      { input: '```', expected: '```\n```' },  // 三个反引号 -> 补齐代码块
      { input: '```j', expected: '```j\n```' },
      { input: '```js\nc', expected: '```js\nc\n```' },
      { input: fullText, expected: fullText }, // 完整文本无需补齐
    ]

    for (const step of steps) {
      const result = completeMarkdown(step.input)
      expect(result).toBe(step.expected)
    }
  })
})
