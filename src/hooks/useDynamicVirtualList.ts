import { useRef, useState, useCallback, useEffect, useMemo } from 'react'
import type { ItemPosition, HeightDiff } from '../types'

/** 默认估算高度（px），用于尚未测量的条目 */
const DEFAULT_ITEM_HEIGHT = 80
/** 视口上下各额外渲染的缓冲条目数 */
const BUFFER_COUNT = 3

interface VisibleRange {
  startIndex: number
  endIndex: number
}

/**
 * useDynamicVirtualList Hook
 *
 * 核心职责：
 * 1. 管理 positions 数组 —— 记录每个条目的 top/height/bottom
 * 2. 根据滚动位置计算当前可见区域（startIndex ~ endIndex）
 * 3. 通过 ResizeObserver 监听真实 DOM 的高度变化
 * 4. 通过 requestIdleCallback 异步批量处理高度变更，避免阻塞主线程
 *
 * @param totalCount - 总条目数
 * @param containerHeight - 滚动容器的可视高度（px）
 */
export function useDynamicVirtualList(totalCount: number, containerHeight: number) {
  const positionsRef = useRef<ItemPosition[]>([])
  const heightDiffQueueRef = useRef<HeightDiff[]>([])
  const ricHandleRef = useRef<number | null>(null)
  const rafUrgentHandleRef = useRef<number | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const scheduleLayoutUpdateRef = useRef<() => void>(() => {})

  // scrollTop 用 ref 存储，避免每像素触发重渲染
  const scrollTopRef = useRef(0)

  // rAF 句柄，用于节流滚动事件
  const rafHandleRef = useRef<number | null>(null)

  // 当前可见范围的 ref（用于在滚动回调中比较）
  const visibleRangeRef = useRef<VisibleRange>({ startIndex: 0, endIndex: 0 })

  // 驱动 React 重渲染的版本号
  const [layoutVersion, setLayoutVersion] = useState(0)

  // 可见范围 state：只在范围变化时才更新，驱动 React 重渲染
  const [visibleRange, setVisibleRange] = useState<VisibleRange>({ startIndex: 0, endIndex: 0 })

  // ===== 二分查找 =====
  const findStartIndex = useCallback((offset: number): number => {
    const positions = positionsRef.current
    if (positions.length === 0) return 0
    let low = 0
    let high = positions.length - 1

    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      if (positions[mid].bottom <= offset) {
        low = mid + 1
      } else if (positions[mid].top > offset) {
        high = mid - 1
      } else {
        return mid
      }
    }
    return Math.min(low, positions.length - 1)
  }, [])

  // ===== 计算可见范围（纯函数，不触发渲染）=====
  const computeVisibleRange = useCallback((scrollTop: number): VisibleRange => {
    if (totalCount === 0) return { startIndex: 0, endIndex: 0 }

    const positions = positionsRef.current
    if (positions.length === 0) return { startIndex: 0, endIndex: 0 }

    const rawStart = findStartIndex(scrollTop)
    const startIndex = Math.max(0, rawStart - BUFFER_COUNT)

    const viewBottom = scrollTop + containerHeight
    let endIndex = rawStart
    while (endIndex < positions.length - 1 && positions[endIndex].top < viewBottom) {
      endIndex++
    }
    endIndex = Math.min(positions.length - 1, endIndex + BUFFER_COUNT)

    return { startIndex, endIndex }
  }, [totalCount, containerHeight, findStartIndex])

  // ===== 比较并更新可见范围，只在变化时触发渲染 =====
  const updateVisibleRangeIfChanged = useCallback((newRange: VisibleRange) => {
    const prev = visibleRangeRef.current
    if (prev.startIndex !== newRange.startIndex || prev.endIndex !== newRange.endIndex) {
      visibleRangeRef.current = newRange
      setVisibleRange(newRange)
    }
  }, [])

  // ===== 初始化 / 扩展 positions 数组 =====
  useEffect(() => {
    const positions = positionsRef.current
    const oldLength = positions.length

    if (totalCount > oldLength) {
      const lastBottom = oldLength > 0 ? positions[oldLength - 1].bottom : 0

      for (let i = oldLength; i < totalCount; i++) {
        const top = i === oldLength ? lastBottom : positions[i - 1].bottom
        positions.push({
          index: i,
          top,
          height: DEFAULT_ITEM_HEIGHT,
          bottom: top + DEFAULT_ITEM_HEIGHT,
        })
      }
    } else if (totalCount < oldLength) {
      positions.length = totalCount
    }

    // totalCount 变化后重新计算可见范围
    updateVisibleRangeIfChanged(computeVisibleRange(scrollTopRef.current))
  }, [totalCount, computeVisibleRange, updateVisibleRangeIfChanged])

  // ===== 计算总列表高度 =====
  const totalHeight = useMemo(() => {
    const positions = positionsRef.current
    if (positions.length === 0) return 0
    return positions[positions.length - 1].bottom
  }, [layoutVersion, totalCount]) // eslint-disable-line react-hooks/exhaustive-deps

  // ===== 执行布局更新（处理队列 + 级联 top/bottom + 滚动补偿）=====
  // deadline 为 null 时不做时间分片，一次性跑完（用于流式尾部项，避免重叠）
  const runLayoutUpdate = useCallback(
    (deadline: IdleDeadline | null) => {
      const queue = heightDiffQueueRef.current
      if (queue.length === 0) return

      const diffs = queue.splice(0, queue.length)
      diffs.sort((a, b) => a.index - b.index)

      const positions = positionsRef.current

      const diffMap = new Map<number, number>()
      for (const d of diffs) {
        diffMap.set(d.index, d.newHeight)
      }

      let minIndex = Infinity
      for (const [index, newHeight] of diffMap) {
        if (index < positions.length && positions[index].height !== newHeight) {
          positions[index].height = newHeight
          if (index < minIndex) minIndex = index
        }
      }

      if (minIndex === Infinity) return

      const currentScrollTop = scrollTopRef.current
      const anchorIndex = findStartIndex(currentScrollTop)
      const oldAnchorTop = anchorIndex < positions.length ? positions[anchorIndex].top : 0

      const timeRemaining = deadline ? () => deadline.timeRemaining() : () => Infinity

      let i = minIndex
      while (i < positions.length) {
        if (timeRemaining() <= 0) {
          heightDiffQueueRef.current.push({
            index: i,
            newHeight: positions[i].height,
          })
          scheduleLayoutUpdateRef.current()
          return
        }

        positions[i].top = i === 0 ? 0 : positions[i - 1].bottom
        positions[i].bottom = positions[i].top + positions[i].height
        i++
      }

      const container = scrollContainerRef.current
      if (container && anchorIndex < positions.length && minIndex <= anchorIndex) {
        const newAnchorTop = positions[anchorIndex].top
        const delta = newAnchorTop - oldAnchorTop
        if (Math.abs(delta) > 0.5) {
          container.scrollTop = currentScrollTop + delta
          scrollTopRef.current = container.scrollTop
        }
      }

      updateVisibleRangeIfChanged(computeVisibleRange(scrollTopRef.current))
      setLayoutVersion((v) => v + 1)
    },
    [findStartIndex, computeVisibleRange, updateVisibleRangeIfChanged]
  )

  // ===== 调度 rIC 异步处理高度变更队列 =====
  const scheduleLayoutUpdate = useCallback(() => {
    if (ricHandleRef.current !== null) return

    const callback = (deadline: IdleDeadline) => {
      ricHandleRef.current = null
      runLayoutUpdate(deadline)
    }

    if (typeof requestIdleCallback !== 'undefined') {
      ricHandleRef.current = requestIdleCallback(callback, { timeout: 100 })
    } else {
      ricHandleRef.current = window.setTimeout(() => {
        callback({ timeRemaining: () => 50, didTimeout: false } as IdleDeadline)
      }, 16) as unknown as number
    }
  }, [runLayoutUpdate])

  useEffect(() => {
    scheduleLayoutUpdateRef.current = scheduleLayoutUpdate
  }, [scheduleLayoutUpdate])

  // ===== 创建 ResizeObserver =====
  useEffect(() => {
    resizeObserverRef.current = new ResizeObserver((entries) => {
      const positions = positionsRef.current
      let lastIndexResized = -1

      for (const entry of entries) {
        const target = entry.target as HTMLElement
        const indexStr = target.dataset.index
        if (indexStr == null) continue

        const index = parseInt(indexStr, 10)
        const newHeight = entry.contentRect.height

        if (index < positions.length && Math.abs(positions[index].height - newHeight) > 0.5) {
          heightDiffQueueRef.current.push({ index, newHeight })
          lastIndexResized = index
        }
      }

      if (heightDiffQueueRef.current.length === 0) return

      // 流式消息通常是最后一项，高度频繁变化。若等 rIC 再更新会延迟数帧，导致该帧内
      // positions/totalHeight 仍为旧值而 DOM 已变高，出现重叠。用 rAF 在下一帧前立即更新布局。
      const isTailResize = positions.length > 0 && lastIndexResized === positions.length - 1
      if (isTailResize) {
        if (rafUrgentHandleRef.current !== null) {
          cancelAnimationFrame(rafUrgentHandleRef.current)
        }
        if (ricHandleRef.current !== null) {
          if (typeof cancelIdleCallback !== 'undefined') {
            cancelIdleCallback(ricHandleRef.current)
          } else {
            clearTimeout(ricHandleRef.current)
          }
          ricHandleRef.current = null
        }
        rafUrgentHandleRef.current = requestAnimationFrame(() => {
          rafUrgentHandleRef.current = null
          runLayoutUpdate(null)
        })
      } else {
        scheduleLayoutUpdate()
      }
    })

    return () => {
      resizeObserverRef.current?.disconnect()
      if (rafUrgentHandleRef.current !== null) {
        cancelAnimationFrame(rafUrgentHandleRef.current)
      }
      if (ricHandleRef.current !== null) {
        if (typeof cancelIdleCallback !== 'undefined') {
          cancelIdleCallback(ricHandleRef.current)
        } else {
          clearTimeout(ricHandleRef.current)
        }
      }
    }
  }, [scheduleLayoutUpdate, runLayoutUpdate])

  // ===== 注册/取消 ResizeObserver 观察 =====
  const observeElement = useCallback((el: HTMLElement | null) => {
    if (el && resizeObserverRef.current) {
      resizeObserverRef.current.observe(el)
    }
  }, [])

  const unobserveElement = useCallback((el: HTMLElement | null) => {
    if (el && resizeObserverRef.current) {
      resizeObserverRef.current.unobserve(el)
    }
  }, [])

  // ===== 滚动事件处理（rAF 节流 + 按需渲染）=====
  const handleScroll = useCallback(() => {
    // 如果已有 rAF 排队，跳过，避免一帧内多次计算
    if (rafHandleRef.current !== null) return

    rafHandleRef.current = requestAnimationFrame(() => {
      rafHandleRef.current = null
      const container = scrollContainerRef.current
      if (!container) return

      scrollTopRef.current = container.scrollTop
      // 只在可见范围变化时触发 React 重渲染
      updateVisibleRangeIfChanged(computeVisibleRange(container.scrollTop))
    })
  }, [computeVisibleRange, updateVisibleRangeIfChanged])

  // 清理 rAF
  useEffect(() => {
    return () => {
      if (rafHandleRef.current !== null) {
        cancelAnimationFrame(rafHandleRef.current)
      }
    }
  }, [])

  // ===== 自动滚动到底部 =====
  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return
    container.scrollTop = container.scrollHeight
  }, [])

  // ===== 获取条目的偏移样式 =====
  const getItemStyle = useCallback((index: number): React.CSSProperties => {
    const positions = positionsRef.current
    if (index >= positions.length) {
      return {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
      }
    }
    return {
      position: 'absolute',
      top: positions[index].top,
      left: 0,
      right: 0,
    }
  }, [layoutVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    scrollContainerRef,
    totalHeight,
    visibleRange,
    getItemStyle,
    observeElement,
    unobserveElement,
    handleScroll,
    scrollToBottom,
  }
}
