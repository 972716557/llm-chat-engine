import { useRef, useState, useCallback, useEffect, useMemo } from 'react'
import type { ItemPosition, HeightDiff } from '../types'

/** 默认估算高度（px），用于尚未测量的条目 */
const DEFAULT_ITEM_HEIGHT = 80
/** 视口上下各额外渲染的缓冲条目数 */
const BUFFER_COUNT = 3

/**
 * useDynamicVirtualList Hook
 *
 * 核心职责：
 * 1. 管理 positions 数组 —— 记录每个条目的 top/height/bottom
 * 2. 根据滚动位置计算当前可见区域（startIndex ~ endIndex）
 * 3. 通过 ResizeObserver 监听真实 DOM 的高度变化
 * 4. 通过 requestIdleCallback 异步批量处理高度变更，避免阻塞主线程
 * 5. 自动锚定底部（流式输出时），用户手动上滚则暂停锚定
 *
 * @param totalCount - 总条目数
 * @param containerHeight - 滚动容器的可视高度（px）
 */
export function useDynamicVirtualList(totalCount: number, containerHeight: number) {
  // ===== positions 数组：记录每个条目的位置信息 =====
  // 使用 useRef 而非 useState，避免每次更新都触发重渲染
  const positionsRef = useRef<ItemPosition[]>([])

  // ===== 高度变更队列（Queue）=====
  // ResizeObserver 回调中只入队，不直接计算
  const heightDiffQueueRef = useRef<HeightDiff[]>([])

  // ===== rIC（requestIdleCallback）句柄，用于取消 =====
  const ricHandleRef = useRef<number | null>(null)

  // ===== 滚动容器 ref =====
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  // ===== 是否锚定底部 =====
  const isAnchoredToBottomRef = useRef(true)

  // ===== 触发 React 视图更新的版本号 =====
  // 当 rIC 完成计算后递增此值，驱动 React 重新渲染
  const [layoutVersion, setLayoutVersion] = useState(0)

  // ===== 滚动偏移量 =====
  const [scrollTop, setScrollTop] = useState(0)

  // ===== ResizeObserver 实例 =====
  const resizeObserverRef = useRef<ResizeObserver | null>(null)

  // ===== 初始化 / 扩展 positions 数组 =====
  // 当 totalCount 增大时，追加新条目的估算位置
  useEffect(() => {
    const positions = positionsRef.current
    const oldLength = positions.length

    if (totalCount > oldLength) {
      // 计算上一个条目的 bottom 作为新条目的起始 top
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
      // 条目减少时截断
      positions.length = totalCount
    }
  }, [totalCount])

  // ===== 计算总列表高度 =====
  const totalHeight = useMemo(() => {
    const positions = positionsRef.current
    if (positions.length === 0) return 0
    return positions[positions.length - 1].bottom
    // layoutVersion 变化时重新计算
  }, [layoutVersion, totalCount])

  // ===== 二分查找：根据 scrollTop 找到第一个 bottom > scrollTop 的条目 =====
  const findStartIndex = useCallback((offset: number): number => {
    const positions = positionsRef.current
    let low = 0
    let high = positions.length - 1

    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      if (positions[mid].bottom <= offset) {
        low = mid + 1
      } else if (positions[mid].top > offset) {
        high = mid - 1
      } else {
        // positions[mid].top <= offset < positions[mid].bottom
        return mid
      }
    }
    return Math.min(low, positions.length - 1)
  }, [])

  // ===== 计算可见区域的 startIndex 和 endIndex =====
  const visibleRange = useMemo(() => {
    if (totalCount === 0) return { startIndex: 0, endIndex: 0 }

    const rawStart = findStartIndex(scrollTop)
    const startIndex = Math.max(0, rawStart - BUFFER_COUNT)

    // 从 rawStart 开始，找到 top > scrollTop + containerHeight 的条目
    const positions = positionsRef.current
    const viewBottom = scrollTop + containerHeight
    let endIndex = rawStart
    while (endIndex < positions.length - 1 && positions[endIndex].top < viewBottom) {
      endIndex++
    }
    endIndex = Math.min(positions.length - 1, endIndex + BUFFER_COUNT)

    return { startIndex, endIndex }
    // layoutVersion 变化时需重新计算
  }, [scrollTop, containerHeight, totalCount, findStartIndex, layoutVersion])

  // ===== 调度 rIC 异步处理高度变更队列 =====
  const scheduleLayoutUpdate = useCallback(() => {
    // 如果已有排队中的 rIC，不重复排队
    if (ricHandleRef.current !== null) return

    const callback = (deadline: IdleDeadline) => {
      ricHandleRef.current = null
      const queue = heightDiffQueueRef.current

      if (queue.length === 0) return

      // 取出所有排队的 diff，按 index 排序（从小到大），方便顺序更新偏移量
      const diffs = queue.splice(0, queue.length)
      diffs.sort((a, b) => a.index - b.index)

      const positions = positionsRef.current

      // 用 Set 去重：同一个 index 只取最后一次的 newHeight
      const diffMap = new Map<number, number>()
      for (const d of diffs) {
        diffMap.set(d.index, d.newHeight)
      }

      // 找到最小受影响的 index，从它开始向后级联更新所有偏移量
      let minIndex = Infinity
      for (const [index, newHeight] of diffMap) {
        if (index < positions.length && positions[index].height !== newHeight) {
          positions[index].height = newHeight
          if (index < minIndex) minIndex = index
        }
      }

      if (minIndex === Infinity) return // 没有实际变更

      // 从 minIndex 开始，重新计算 top 和 bottom
      // 利用 deadline.timeRemaining() 做时间分片，避免超长列表阻塞
      let i = minIndex
      while (i < positions.length) {
        if (deadline.timeRemaining() <= 0) {
          // 时间片用完，重新调度继续处理剩余部分
          // 把剩余的重新入队
          for (let j = i; j < positions.length; j++) {
            heightDiffQueueRef.current.push({
              index: j,
              newHeight: positions[j].height,
            })
          }
          scheduleLayoutUpdate()
          break
        }

        positions[i].top = i === 0 ? 0 : positions[i - 1].bottom
        positions[i].bottom = positions[i].top + positions[i].height
        i++
      }

      // 统一触发 React 视图更新
      setLayoutVersion((v) => v + 1)
    }

    // 调用 requestIdleCallback，设置超时兜底（100ms 内必须执行）
    if (typeof requestIdleCallback !== 'undefined') {
      ricHandleRef.current = requestIdleCallback(callback, { timeout: 100 })
    } else {
      // 降级：不支持 rIC 时用 setTimeout
      ricHandleRef.current = window.setTimeout(() => {
        callback({ timeRemaining: () => 50, didTimeout: false } as IdleDeadline)
      }, 16) as unknown as number
    }
  }, [])

  // ===== 创建 ResizeObserver =====
  useEffect(() => {
    resizeObserverRef.current = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // 从 DOM 节点上读取 data-index 属性
        const target = entry.target as HTMLElement
        const indexStr = target.dataset.index
        if (indexStr == null) continue

        const index = parseInt(indexStr, 10)
        const newHeight = entry.contentRect.height

        // 只有高度真正变化才入队
        const positions = positionsRef.current
        if (index < positions.length && Math.abs(positions[index].height - newHeight) > 0.5) {
          heightDiffQueueRef.current.push({ index, newHeight })
          scheduleLayoutUpdate()
        }
      }
    })

    return () => {
      resizeObserverRef.current?.disconnect()
      if (ricHandleRef.current !== null) {
        if (typeof cancelIdleCallback !== 'undefined') {
          cancelIdleCallback(ricHandleRef.current)
        } else {
          clearTimeout(ricHandleRef.current)
        }
      }
    }
  }, [scheduleLayoutUpdate])

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

  // ===== 滚动事件处理 =====
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return

    const newScrollTop = container.scrollTop
    setScrollTop(newScrollTop)

    // 判断是否接近底部（距底部 50px 以内认为是锚定状态）
    const distanceToBottom = container.scrollHeight - container.clientHeight - newScrollTop
    isAnchoredToBottomRef.current = distanceToBottom < 50
  }, [])

  // ===== 自动滚动到底部 =====
  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return
    container.scrollTop = container.scrollHeight
  }, [])

  // ===== 当 totalHeight 变化时，如果锚定底部则自动滚动 =====
  useEffect(() => {
    if (isAnchoredToBottomRef.current) {
      // 使用 rAF 确保 DOM 已更新后再滚动
      requestAnimationFrame(() => {
        scrollToBottom()
      })
    }
  }, [totalHeight, totalCount, scrollToBottom])

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
    /** 滚动容器 ref */
    scrollContainerRef,
    /** 列表总高度（用于撑开滚动区域） */
    totalHeight,
    /** 当前可见区域的起止索引 */
    visibleRange,
    /** 获取指定条目的绝对定位样式 */
    getItemStyle,
    /** 注册 ResizeObserver 观察某个 DOM 元素 */
    observeElement,
    /** 取消 ResizeObserver 观察 */
    unobserveElement,
    /** 滚动事件回调，绑定到容器的 onScroll */
    handleScroll,
    /** 手动滚动到底部 */
    scrollToBottom,
    /** 是否锚定在底部 */
    isAnchoredToBottom: isAnchoredToBottomRef,
  }
}
