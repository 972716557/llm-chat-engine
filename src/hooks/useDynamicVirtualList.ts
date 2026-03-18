import { useRef, useState, useCallback, useEffect, useMemo } from 'react'
import type { ItemPosition, HeightDiff } from '../types'

/** 默认估算高度（px），用于尚未测量的条目；真实高度由 ResizeObserver 测量后覆盖 */
const DEFAULT_ITEM_HEIGHT = 80
/** 视口上下各额外渲染的缓冲条目数，减少快速滚动时的空白闪烁 */
const BUFFER_COUNT = 3

interface VisibleRange {
  startIndex: number
  endIndex: number
}

/**
 * useDynamicVirtualList —— 动态高度虚拟滚动
 *
 * 是否区分每条消息/每个条目的高度？
 * - 是。列表中每个「条目」都有独立的位置信息 positions[i]（top / height / bottom），
 *   高度按条目单独记录，不假设所有条目等高。
 *
 * 长消息如何做虚拟滚动？
 * - 虚拟化粒度是「块」（block），不是「消息」。上层会把一条长消息拆成多个块
 *   （见 ChatContainer 的 flattenToBlocks / splitMarkdownBlocks），每个块作为列表的
 *   一个条目。因此「某一条消息过长」= 该消息对应多个条目，每个条目各自占一行、
 *   各自有独立高度，由 ResizeObserver 逐条测量。长消息不会变成单条超高项，而是
 *   多条正常高度的项，从而既能区分每条高度，又能对长内容做虚拟滚动。
 *
 * 核心职责：
 * 1. 管理 positions 数组：每个条目一条记录，含该条目的 top / height / bottom
 * 2. 根据 scrollTop 计算当前可见区间（startIndex ~ endIndex），只渲染该区间 + 缓冲
 * 3. 用 ResizeObserver 监听每个已渲染条目的真实高度，更新对应 positions[i].height
 * 4. 用 requestIdleCallback（或尾部项用 requestAnimationFrame）异步/即时更新布局，避免卡顿与重叠
 *
 * @param totalCount - 列表条目总数（在聊天场景下 = 所有消息展平后的块数）
 * @param containerHeight - 滚动容器的可视高度（px）
 */
export function useDynamicVirtualList(totalCount: number, containerHeight: number) {
  /** 每个条目的位置与高度；下标 i 对应第 i 个条目，长消息会对应多个连续下标 */
  const positionsRef = useRef<ItemPosition[]>([])
  /** 高度变更队列：ResizeObserver 回调只入队，由 rIC/rAF 统一处理避免重复计算 */
  const heightDiffQueueRef = useRef<HeightDiff[]>([])
  /** requestIdleCallback 句柄，用于异步批量更新非尾部条目高度 */
  const ricHandleRef = useRef<number | null>(null)
  /** requestAnimationFrame 句柄，用于尾部条目（如流式消息）高度变化时下一帧前立即更新，避免重叠 */
  const rafUrgentHandleRef = useRef<number | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  /** 避免 runLayoutUpdate 与 scheduleLayoutUpdate 循环依赖，用于时间片用尽时再次调度 */
  const scheduleLayoutUpdateRef = useRef<() => void>(() => {})

  /** scrollTop 用 ref 存，避免滚动时每像素都触发 setState 重渲染 */
  const scrollTopRef = useRef(0)

  /** 滚动事件的 rAF 节流句柄，一帧内只计算一次可见范围 */
  const rafHandleRef = useRef<number | null>(null)

  /** 当前可见范围缓存，用于比较是否变化，只有变化才 setVisibleRange 触发渲染 */
  const visibleRangeRef = useRef<VisibleRange>({ startIndex: 0, endIndex: 0 })

  /** 布局版本号：positions 发生级联更新后自增，驱动 totalHeight / getItemStyle 依赖更新 */
  const [layoutVersion, setLayoutVersion] = useState(0)

  /** 当前可见的起止下标，仅当 startIndex/endIndex 变化时更新，用于决定渲染哪几条 */
  const [visibleRange, setVisibleRange] = useState<VisibleRange>({ startIndex: 0, endIndex: 0 })

  // ===== 二分查找：给定垂直偏移 offset，找到包含该偏移的条目下标 =====
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

  // ===== 根据当前 scrollTop 计算可见区间（纯函数，不触发渲染）=====
  // 利用每个条目的 top/bottom 精确判断哪些条目落在视口内，支持每条高度不同
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

  // ===== 仅当可见范围真正变化时更新 state，避免无意义的列表重渲染 =====
  const updateVisibleRangeIfChanged = useCallback((newRange: VisibleRange) => {
    const prev = visibleRangeRef.current
    if (prev.startIndex !== newRange.startIndex || prev.endIndex !== newRange.endIndex) {
      visibleRangeRef.current = newRange
      setVisibleRange(newRange)
    }
  }, [])

  // ===== 条目数增加时扩展 positions，新条目先用预估高度；减少时截断 =====
  // 每个新条目都有独立的 top/height/bottom，后续由 ResizeObserver 按条目更新 height
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

    updateVisibleRangeIfChanged(computeVisibleRange(scrollTopRef.current))
  }, [totalCount, computeVisibleRange, updateVisibleRangeIfChanged])

  // ===== 列表总高度 = 最后一条的 bottom，依赖 layoutVersion 以在高度更新后重算 =====
  const totalHeight = useMemo(() => {
    const positions = positionsRef.current
    if (positions.length === 0) return 0
    return positions[positions.length - 1].bottom
  }, [layoutVersion, totalCount]) // eslint-disable-line react-hooks/exhaustive-deps

  // ===== 执行布局更新：按条目应用高度变更并级联重算后续条目的 top/bottom =====
  // 每个条目高度独立更新；某一条变高后，其后所有条目的 top/bottom 依次重算，保证连续无重叠
  // deadline 为 null 时不做时间分片，一次性跑完（用于流式尾部项，避免重叠）
  const runLayoutUpdate = useCallback(
    (deadline: IdleDeadline | null) => {
      const queue = heightDiffQueueRef.current
      if (queue.length === 0) return

      const diffs = queue.splice(0, queue.length)
      diffs.sort((a, b) => a.index - b.index)

      const positions = positionsRef.current

      // 同一条目可能多次入队，只保留最新高度
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

      // 从最小变更下标开始，逐条重算 top/bottom（每条高度独立，只级联位置）
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

      // 若变更发生在视口锚点上方，补偿 scrollTop 避免内容跳动
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

  // ===== 将布局更新推迟到空闲时执行（rIC），避免阻塞主线程；尾部项由 ResizeObserver 内走 rAF =====
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

  // ===== ResizeObserver：按条目监听已渲染 DOM 的真实高度，区分每个条目的高度 =====
  // 每个可见条目挂载时通过 observeElement 注册，卸载时 unobserve；同一批 entries 可能含多条
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

      // 流式消息通常是最后一项，高度频繁变化；用 rAF 在下一帧前更新，避免与 rIC 延迟导致的重叠
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

  // ===== 供每条可见条目挂载时调用：把该条目的 DOM 交给 ResizeObserver，用于按条目测量高度 =====
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

  // ===== 滚动：rAF 节流 + 仅当可见范围变化时更新 state，减少重渲染 =====
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

  // ===== 返回指定条目的绝对定位样式：top 来自该条目的 positions[i].top，每条高度独立 =====
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
