import {
  createVirtualizer,
  defaultRangeExtractor,
  elementScroll,
  observeElementRect,
  type Range,
  type VirtualItem,
} from "@tanstack/solid-virtual"
import { isScrollKeyTarget, scrollKey, scrollKeyOwner, ScrollView } from "@opencode/ui/scroll-view"
import { Predicate } from "effect"
import { Timeline, TimelineRow } from "@opencode/session-ui/timeline/projection"
import {
  readTimelineTypography,
  type TimelineLayoutEnvironment,
  type TimelineRowLayout,
} from "@opencode/session-ui/timeline/text-layout"
import { useLanguage } from "@/runtime/i18n/language"
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  type Accessor,
  type JSX,
} from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import type { createTimelineProjection } from "./projection"
import { observeElementOffsetReconnectAware } from "./observe-element-offset"
import { filterVirtualIndexes } from "./virtual-items"
import { enter, prefersReducedMotion } from "@opencode/ui/motion"
import { landSendFlight } from "./send-flight"
import { createRowGrowth } from "./row-growth"

const fallbackItemSize = 60

const grid = (value: number) => Math.round(value * 64) / 64

const gridHeight = (element: Element) => grid(element.getBoundingClientRect().height)

// Reserved below the last row: a 36px lane for the live status row and its background hint, an 8px gap, then a 36px
// lane that the composer's activity pill floats in. Both come and go inside it, so neither moves the rows above.
const tailSize = 80

const pendingMarkdown = '[data-component="markdown"]:not([data-markdown-ready])'

// Distance from the bottom that counts as "at the end". Deliberately tight: a collapse clamps
// exactly to the end, while a one-pixel nudge upward is a deliberate move away from it.
const endEpsilon = 0.5

const upwardKeys = new Set(["up", "page-up", "home"])

const cache = new Map<
  string,
  {
    measurements: VirtualItem[]
    toolOpen: Record<string, boolean | undefined>
    patchGroupKeys: Map<string, string>
    presentationKey?: string
  }
>()

type Projection = Pick<
  ReturnType<typeof createTimelineProjection>,
  "activeMessageID" | "messageByID" | "messageLastRowIndex" | "messageRowIndex" | "rowByKey" | "rows"
>

type Input = {
  active?: Accessor<boolean>
  sessionKey: Accessor<string>
  presentationKey?: Accessor<string>
  projection: Projection
  showHeader: Accessor<boolean>
  layout: (row: TimelineRow.TimelineRow, environment: TimelineLayoutEnvironment) => TimelineRowLayout
  /** True while the timeline follows the newest content. Drives every anchoring decision. */
  pinned: Accessor<boolean>
  scroll: Accessor<{ overflow: boolean; jump: boolean }>
  onResumeScroll: (behavior?: ScrollBehavior) => void
  setScrollRef: (element: HTMLDivElement | undefined) => void
  setContentRef: (element: HTMLDivElement) => void
  /** Height of the composer region floating over the timeline's bottom edge, where the timeline fades out. */
  bottomInset?: Accessor<number>
  setVisibleRef?: (element: HTMLDivElement | undefined) => void
  onScheduleScrollState: (element: HTMLDivElement) => void
  onPin: () => void
  onUnpin: () => void
  onSelectionInteraction: (event: MouseEvent) => void
  onUserScroll: (target?: EventTarget | null) => void
  onHistoryScroll: () => void
  canRenderImmediately?: (
    row: TimelineRow.TimelineRow,
    disclosure: Readonly<Record<string, boolean | undefined>>,
  ) => boolean
  setRevealMessage?: (fn: (id: string, partID?: string) => void) => void
  setRevealPart?: (fn: (target: string) => boolean) => void
  setScrollToEnd?: (fn: (behavior?: ScrollBehavior) => void) => void
  /** A tool call the route asks this timeline to open on; `done` clears it once revealed. */
  reveal?: { target: () => string | undefined; done: () => void }
}

type ViewProps = {
  header: JSX.Element
  bottomSpacer?: JSX.Element
  deferred: (row: TimelineRow.TimelineRow) => boolean
  renderRow: (row: Accessor<TimelineRow.TimelineRow>, onSizeChange?: () => void) => JSX.Element
}

export function createTimelineVirtualizer(input: Input) {
  const language = useLanguage()
  const active = () => input.active?.() !== false
  const isDesktop = createMediaQuery("(min-width: 768px)")
  const topOffset = () => (input.showHeader() ? 64 : isDesktop() ? 0 : 16)
  const ownerSessionKey = input.sessionKey()
  const entry = cache.get(ownerSessionKey)
  const cached = entry?.presentationKey === input.presentationKey?.() ? entry : undefined
  const initialMeasurements = cached?.measurements
  const coldBottomMount = !initialMeasurements?.length && input.pinned()
  const [listRoot, setListRoot] = createSignal<HTMLDivElement>()
  const [visibleArea, setVisibleArea] = createSignal<HTMLDivElement>()
  const [viewRoot, setViewRoot] = createSignal<HTMLDivElement>()
  const bottomInset = () => input.bottomInset?.() ?? 0
  const [layoutState, setLayoutState] = createStore<{
    environment?: TimelineLayoutEnvironment
    fontsReady: boolean
    viewport: number
    offset: number
    held: number
  }>({ fontsReady: false, viewport: 0, offset: 0, held: 0 })
  const layouts = createMemo(() => {
    const environment = layoutState.environment
    if (!environment) return new Map<string, TimelineRowLayout>()
    return new Map(input.projection.rows().map((row) => [TimelineRow.key(row), input.layout(row, environment)]))
  })
  const modelHeight = (key: string) => {
    const value = layouts().get(key)
    return value && value.source !== "dom" ? value.height : undefined
  }
  const fullyModeled = createMemo(
    () => !!layoutState.environment && [...layouts().values()].every((value) => value.source !== "dom"),
  )
  const [toolOpen, setToolOpen] = createStore<Record<string, boolean | undefined>>(cached?.toolOpen ?? {})
  const patchGroupKeys = cached?.patchGroupKeys ?? new Map<string, string>()
  createEffect(
    on(
      () => input.presentationKey?.(),
      () => setToolOpen(reconcile({})),
      { defer: true },
    ),
  )

  const [rendering, setRendering] = createStore<{
    initialTail: boolean
    scrollAdjustment: number
    /** A revealed tool whose top edge stays put until the user scrolls. */
    anchor?: { key: string; partID: string }
  }>({ initialTail: coldBottomMount, scrollAdjustment: 0 })

  const rows = input.projection.rows
  const rowByKey = input.projection.rowByKey

  const rowKeys = createMemo(() => rows().map(TimelineRow.key), undefined, {
    equals: (previous, next) => previous.length === next.length && previous.every((key, index) => key === next[index]),
  })

  const knownKeys = new Set(rowKeys())
  const addedKeys = new Set<string>()
  // Rows added after the first one already shown, at the end or among the last rows. While following, they grow in
  // instead of landing.
  const arrivals = new Set<string>()
  const [leavingKeys, setLeavingKeys] = createSignal<string[]>([])

  let listedKeys = rowKeys()

  const getItemKey = createMemo(() => {
    const keys = rowKeys()
    const previous = listedKeys
    listedKeys = keys
    const head = keys.findIndex((key) => knownKeys.has(key))
    keys.forEach((key, index) => {
      if (knownKeys.has(key)) return
      knownKeys.add(key)
      addedKeys.add(key)

      if (head < 0 || index > head) arrivals.add(key)
    })
    closeRemoved(previous, keys)

    return (index: number) => keys[index] ?? `removed:${index}`
  })

  const rangeExtractor = createMemo(() => {
    const id = input.projection.activeMessageID()
    const active = id ? (input.projection.messageLastRowIndex().get(id) ?? -1) : -1
    const initialTail = rendering.initialTail && input.pinned()
    const anchored = rendering.anchor ? rowKeys().indexOf(rendering.anchor.key) : -1

    return (range: Range) => {
      // Batch a bounded cheap suffix, but stop before unknown/large content.
      // A large tail still mounts alone before estimates expose earlier history.
      const start = Math.max(0, range.startIndex - 2)

      const boundary = initialTail
        ? rows()
            .slice(start, range.count)
            .findLastIndex(
              (row) =>
                !(
                  Predicate.isTagged(row, "AssistantPart") &&
                  row.group.type === "context" &&
                  row.group.refs.length <= 64 &&
                  !toolOpen[`context:${row.group.key}`]
                ) && !input.canRenderImmediately?.(row, toolOpen),
            )
        : -1

      const first = Math.min(range.count - 1, start + boundary + 1)

      const indexes = initialTail
        ? Array.from({ length: range.count - first }, (_, index) => first + index)
        : defaultRangeExtractor({ ...range, overscan: 2 })

      return filterVirtualIndexes(
        [...new Set([...indexes, ...[active, anchored].filter((index) => index >= 0)])].sort((a, b) => a - b),
        range.count,
      )
    }
  })

  const measuredElements = new WeakSet<Element>()
  const observedElements = new WeakSet<Element>()
  let touchStart: number | undefined
  let touchTarget: EventTarget | null = null
  let touchNested = false
  let touchScrolling = false
  let touchAdjustment = 0
  let pointerHeld = false
  let userScrollAt = -Infinity
  let maxScroll = 0
  let virtualContent: HTMLDivElement | undefined
  let scrollTop = 0
  let reportOffset: ((offset: number, scrolling: boolean) => void) | undefined
  let reportRect: ((rect: { width: number; height: number }) => void) | undefined
  // The list root's last observed size; the composer region moving its edge does not resize it.
  let rootRect: { width: number; height: number } | undefined
  let batchingColdSizes = false
  let coldPending = coldBottomMount
  // The whole-pixel offset last written, while a translate draws the fraction it dropped.
  let wholeTop: number | undefined
  // Sizes held back from rows still streaming, applied once their text completes.
  const shrinks = new Map<string, number>()

  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return rows().length
    },
    getScrollElement: () => listRoot() ?? null,
    // The viewport runs on under the composer region. The virtualizer sees only the part above it, which the
    // inset spacer below the rows keeps consistent with the native scroll range.
    observeElementRect: (instance, callback) => {
      reportRect = (rect) => {
        // Rows rewrap at a new width: their heights mean something else, so growth lands.
        if (Math.abs(rect.width - (instance.scrollRect?.width ?? 0)) >= 1) landGrowth()
        callback({ width: rect.width, height: Math.max(0, rect.height - bottomInset()) })
      }

      return observeElementRect(instance, (rect) => {
        const resized = rootRect !== undefined && (rootRect.width !== rect.width || rootRect.height !== rect.height)
        rootRect = rect
        setLayoutState("viewport", rect.height)
        if (layoutState.environment) setLayoutState("environment", { width: rect.width, desktop: isDesktop() })

        if (!active()) return
        reportRect?.(rect)
        // A viewport resize changes the DOM gap without changing the reader's intent. Restore the followed end
        // before the next growth frame tests that gap; otherwise a smaller viewport strands every later append.
        if (resized && input.pinned())
          queueMicrotask(() => {
            if (active() && input.pinned()) pinEnd()
          })
      })
    },
    // Route navigation detaches and reattaches the scroll element, which drops its offset.
    observeElementOffset: (instance, callback) => {
      reportOffset = (offset, scrolling) => {
        if (!active()) return
        setLayoutState("offset", offset)
        // Rows and the sizer use the opposite translation while native touch
        // scrolling keeps its own offset. Range selection uses the logical offset.
        batch(() => {
          const logicalOffset = offset + rendering.scrollAdjustment
          callback(rendering.scrollAdjustment ? Math.max(0, logicalOffset) : offset, scrolling)
          // Reconcile both start boundaries in one native write. Gradually
          // clamping row translations lets the compositor paint between
          // corrections and makes the content oscillate at the top.
          const root = listRoot()

          if (
            rendering.scrollAdjustment !== 0 &&
            root &&
            (logicalOffset <= 0 || offset <= 0 || (touchStart !== undefined && offset <= layoutState.viewport))
          )
            flushTouchAdjustment()

          if (!scrolling && touchStart === undefined) finishTouchScroll()
        })
        settleColdBottom()
      }

      return observeElementOffsetReconnectAware(instance, reportOffset, () => {
        if (!active()) return
        virtualContent?.querySelectorAll<HTMLDivElement>("[data-index]").forEach(virtualizer.measureElement)

        if (input.pinned()) virtualizer.scrollToEnd()
        settleColdBottom()
      })
    },
    initialOffset: () => (input.pinned() ? Number.MAX_SAFE_INTEGER : 0),
    initialMeasurementsCache: initialMeasurements,
    // A row arriving at a followed end grows in from nothing, so it never paints first at the estimate.
    estimateSize: (index) =>
      modelHeight(getItemKey()(index)) ?? (arrivals.has(getItemKey()(index)) && following() ? 0 : fallbackItemSize),
    // A newly observed element gets a real ResizeObserver box before paint. Reuse
    // its snapshot on attachment, but later explicit measurements must read layout
    // so deferred/rewrapped content cannot keep stale, clipped heights (TanStack/virtual#1183).
    measureElement: (element, entry, instance) => {
      const model = modelHeight(rowKeys()[instance.indexFromElement(element)]!)
      if (model !== undefined) {
        const first = !observedElements.has(element)
        observedElements.add(element)
        if (coldPending && first) settleColdBottom()
        return model
      }
      if (!active() || !element.isConnected)
        return (
          instance.itemSizeCache.get(instance.options.getItemKey(instance.indexFromElement(element))) ??
          fallbackItemSize
        )
      const initial = !measuredElements.has(element)
      measuredElements.add(element)
      const box = entry?.borderBoxSize[0]

      if (box) {
        const first = !observedElements.has(element)
        observedElements.add(element)

        if (coldPending && first) settleColdBottom()

        return grid(box.blockSize)
      }

      if (initial) {
        const size = instance.itemSizeCache.get(instance.options.getItemKey(instance.indexFromElement(element)))

        if (size !== undefined || coldPending) return size ?? fallbackItemSize
      }

      return gridHeight(element)
    },
    scrollToFn: (offset, options, instance) => {
      if (!active()) return

      if (batchingColdSizes && input.pinned()) return
      setRendering("scrollAdjustment", 0)

      if (virtualContent) virtualContent.style.height = `${instance.getTotalSize()}px`
      const root = listRoot()

      if (root && options.behavior !== "smooth") return writeScroll(root, offset + (options.adjustments ?? 0))
      clearRemainder()
      elementScroll(offset, options, instance)
    },
    get getItemKey() {
      return getItemKey()
    },
    get anchorTo() {
      return input.pinned() ? "end" : "start"
    },
    get followOnAppend() {
      // Animated growth owns the followed offset. A second scroll-to-end here
      // uses the previous DOM range while optimistic rows are still measuring.
      return input.pinned() && !following()
    },
    scrollEndThreshold: 80,
    get scrollMargin() {
      // Empty projections still need the bottom spacer for running status.
      return rows().length > 0 ? topOffset() : 0
    },
    paddingEnd: tailSize,
    get rangeExtractor() {
      return rangeExtractor()
    },
  })

  const resizeItem = virtualizer.resizeItem

  function rowHeight(element: HTMLDivElement) {
    return modelHeight(rowKeys()[virtualizer.indexFromElement(element)]!) ?? gridHeight(element)
  }

  const scrollGeometry = createMemo(() => ({
    extent: Math.max(
      layoutState.viewport,
      topOffset() + virtualizer.getTotalSize() + bottomInset() + layoutState.held - rendering.scrollAdjustment,
    ),
    viewport: layoutState.viewport,
    offset: layoutState.offset,
    track: Math.max(0, layoutState.viewport - bottomInset()),
  }))
  const endOffset = () => Math.max(0, scrollGeometry().extent - scrollGeometry().viewport)

  createEffect(() => {
    const values = layouts()
    if (!values.size) return
    queueMicrotask(() => {
      batch(() =>
        rowKeys().forEach((key, index) => {
          const value = values.get(key)
          if (value && value.source !== "dom") virtualizer.resizeItem(index, value.height)
        }),
      )
    })
  })

  // Read before the frame's writes. Follow intent survives layout changes that temporarily enlarge the DOM gap.
  let viewport = 0
  // Space held under the last row so the end eases onto the composer instead of stopping there.
  let lift = 0
  let ride: { from: number; gap: number; to: number } | undefined
  let heldSpace = 0
  let insetSpacer: HTMLDivElement | undefined
  const [shift, setShift] = createSignal({ rows: 0, size: 0 })
  // Whether the held gap is space the composer freed under the last row, rather than a row's place in the list.
  let endGap = false

  // Each frame's displayed heights go in without TanStack's per-row scroll adjustment, then one write keeps the end
  // in place for the whole frame, so the rows above glide.
  const growth = createRowGrowth({
    measure: () => {
      viewport = layoutState.viewport
    },
    resize: (key, size) => {
      const index = rowKeys().lastIndexOf(key)

      if (index < 0) return false
      virtualizer.options.anchorTo = "start"
      resizeItem(index, size)
      virtualizer.options.anchorTo = input.pinned() ? "end" : "start"

      return virtualizer.elementsCache.get(key)?.parentElement ?? undefined
    },
    below: (key) => rowKeys().lastIndexOf(key) >= shift().rows,
    settle: (state) => {
      rideEnd(state.pending)

      if (!state.held) endGap = false

      if (state.held !== shift().size) setShift((value) => ({ rows: state.held ? value.rows : 0, size: state.held }))
      moveGhosts()
    },
  })

  // Growing past the composer, the end follows the rows' own progress onto it: the space below it closes as they
  // finish growing, rather than the end travelling down and stopping dead at the composer's edge.
  const rideEnd = (pending: number) => {
    const root = listRoot()
    const total = virtualizer.getTotalSize()
    const target = total + pending
    const room = (virtualizer.scrollRect?.height ?? 0) - virtualizer.options.scrollMargin

    if (pending < 1 || target <= room || !input.pinned()) {
      ride = undefined
      lift = 0
    }

    if (ride?.to !== target && lift + pending >= 1 && target > room && input.pinned())
      ride = { from: total, gap: Math.max(room - total, lift), to: target }

    if (ride) lift = ride.gap * (1 - Math.min(1, Math.max(0, (total - ride.from) / Math.max(1, ride.to - ride.from))))

    holdSpace(grid(lift))

    if (root && input.pinned()) pinEnd(viewport)
  }

  function pinEnd(viewport?: number) {
    const root = listRoot()

    if (!root) return
    writeScroll(
      root,
      topOffset() + virtualizer.getTotalSize() + bottomInset() + heldSpace - (viewport ?? layoutState.viewport),
    )
  }

  // Native scroll offsets snap to whole pixels. Each write takes the whole pixel below and draws the rest as a
  // translate, so row edges stay on the 1/64 px grid instead of trembling with the rounding.
  function writeScroll(root: HTMLDivElement, offset: number) {
    const exact = Math.max(0, Math.min(offset, endOffset()))
    wholeTop = Math.floor(exact)
    // Commit the extent before the offset, without asking layout to rediscover either value.
    if (virtualContent) virtualContent.style.height = `${virtualizer.getTotalSize() - rendering.scrollAdjustment}px`
    root.scrollTop = wholeTop
    setLayoutState("offset", wholeTop)

    if (wholeTop === exact) return virtualContent?.style.removeProperty("translate")
    virtualContent?.style.setProperty("translate", `0 ${wholeTop - exact}px`)
  }

  function clearRemainder() {
    wholeTop = undefined
    virtualContent?.style.removeProperty("translate")
  }

  const holdSpace = (space: number) => {
    if (space === heldSpace) return
    heldSpace = space
    setLayoutState("held", space)

    if (!space) return insetSpacer?.style.removeProperty("height")
    insetSpacer?.style.setProperty("height", `calc(var(--session-timeline-inset) + ${space}px)`)
  }

  // Lands every growing row and closes any gap or space held at the end at once.
  const landGrowth = () => {
    shrinks.forEach((size, key) => {
      const index = rowKeys().lastIndexOf(key)

      if (index >= 0) resizeItem(index, size)
    })
    shrinks.clear()
    growth.finish()
    ride = undefined
    lift = 0
    holdSpace(0)
    endGap = false
    setShift({ rows: 0, size: 0 })
  }

  const commitSize = (index: number, key: string, size: number) => {
    const measured = virtualizer.itemSizeCache.get(key)
    const arriving = arrivals.has(key)
    const shown = measured ?? (arriving ? 0 : undefined)

    // A deferred row can report zero before its contents mount. Its first visible measurement still owns entrance.
    if (size > 0) arrivals.delete(key)

    // Streamed markdown can lose a line for a moment as it settles (a closing fence, say). While it streams, a followed
    // row never shrinks below what it shows, and gives back what it lost once the text completes. A target that drops
    // but stays above what is shown just bends the growth down to it.
    if (shown !== undefined && size < shown && following() && streaming(rows()[index])) return shrinks.set(key, size)
    shrinks.delete(key)

    if (shown === undefined || !grows(index, shown, size)) {
      if (growth.target(key) !== undefined) return growth.land(key, size)

      return resizeItem(index, size)
    }

    if (measured === undefined) {
      resizeItem(index, 0)
      virtualizer.itemSizeCache.set(key, 0)
    }

    if (arriving) {
      const element = virtualizer.elementsCache.get(key)

      if (element && !textMessage(rows()[index])) enter(element, { duration: 200 })
    }

    growth.grow(key, shown, size)
  }

  const grows = (index: number, shown: number, size: number) => {
    const root = listRoot()
    const item = virtualizer.measurementsCache[index]
    const delta = Math.abs(size - shown)

    return (
      !!root &&
      !!item &&
      following() &&
      (delta >= 1 / 64 || growth.target(String(item.key)) !== undefined) &&
      delta <= layoutState.viewport &&
      item.start + shown > layoutState.offset
    )
  }

  function following() {
    return input.pinned() && !coldPending && touchStart === undefined && !prefersReducedMotion()
  }

  // A row near the end leaves while the timeline follows it: the offset clamps to the shorter end and the rows above
  // would drop into its place in one frame. They start where they were and close the gap on the growth spring, while
  // the original row stays mounted until its fade finishes.
  function closeRemoved(previous: string[], keys: string[]) {
    if (previous === keys) return
    const remaining = new Set(keys)
    const leaving = previous.filter((key) => !remaining.has(key))

    if (!leaving.length) return
    const first = previous.indexOf(leaving[0]!)
    const removed = leaving.reduce((sum, key) => sum + (virtualizer.itemSizeCache.get(key) ?? 0), 0)
    const root = listRoot()
    const max = endOffset()

    const drop =
      previous.length - first <= 4 && root && following() && max - layoutState.offset <= 1 ? Math.min(removed, max) : 0

    if (drop >= 1) leaving.forEach((key) => fadeOutRow(key, previous[first - 1], drop))
    leaving.forEach((key) => {
      knownKeys.delete(key)
      addedKeys.delete(key)
      arrivals.delete(key)
      virtualizer.itemSizeCache.delete(key)
    })

    if (drop < 1) return
    endGap = false
    setShift((value) => ({
      rows: previous.slice(0, first).filter((key) => remaining.has(key)).length,
      size: value.size + drop,
    }))
    growth.hold(drop)
    queueMicrotask(() => {
      if (input.pinned()) pinEnd()
    })
  }

  const ghosts = new Map<HTMLElement, { key: string; top: number }>()

  function fadeOutRow(key: string, above: string | undefined, drop: number) {
    const wrapper = virtualizer.elementsCache.get(key)?.parentElement
    const anchor = above === undefined ? undefined : virtualizer.measurementsCache[rowKeys().lastIndexOf(above)]

    if (!wrapper?.isConnected || !virtualContent || !above || !anchor) return
    setLeavingKeys((keys) => [...keys, key])
    wrapper.setAttribute("aria-hidden", "true")
    wrapper.inert = true
    wrapper.style.pointerEvents = "none"
    wrapper.style.top = `${parseFloat(wrapper.style.top) - drop}px`
    ghosts.set(wrapper, { key: above, top: anchor.start - topOffset() - shift().size - drop })
    const fade = wrapper.animate([{ opacity: getComputedStyle(wrapper).opacity }, { opacity: 0 }], {
      duration: 110,
      easing: "cubic-bezier(.4,0,1,1)",
      fill: "forwards",
    })
    void fade.finished.then(
      () => {
        ghosts.delete(wrapper)
        setLeavingKeys((keys) => keys.filter((item) => item !== key))
      },
      () => undefined,
    )
  }

  const moveGhosts = () =>
    ghosts.forEach((anchor, ghost) => {
      const index = rowKeys().lastIndexOf(anchor.key)
      const item = virtualizer.measurementsCache[index]
      const top = item && item.start - topOffset() - (index < shift().rows ? shift().size : 0)

      if (top === undefined || top === anchor.top) return
      ghost.style.top = `${parseFloat(ghost.style.top) + top - anchor.top}px`
      anchor.top = top
    })

  const textMessage = (row: TimelineRow.TimelineRow | undefined) => {
    if (!Predicate.isTagged(row, "AssistantPart") || row.group.type !== "part") return
    const message = input.projection.messageByID().get(row.group.ref.messageID)

    if (Timeline.resolveContent(message, row.group.ref.partID)?.type === "text") return message
  }

  const streaming = (row: TimelineRow.TimelineRow | undefined) => {
    const message = textMessage(row)

    return message?.type === "assistant" && message.time.completed === undefined
  }

  createEffect(() => {
    input.projection.messageByID()
    shrinks.forEach((_, key) => {
      if (streaming(rows()[rowKeys().lastIndexOf(key)])) return
      shrinks.delete(key)
      requestAnimationFrame(() => {
        const element = virtualizer.elementsCache.get(key)
        const index = rowKeys().lastIndexOf(key)

        if (element?.isConnected && index >= 0) virtualizer.resizeItem(index, rowHeight(element))
      })
    })
  })

  const pendingSizes = new Map<number, { key: string; size: number }>()
  let resizeScheduled = false
  // Read the whole measurement delivery before committing reactive row sizes.
  // Otherwise each row can render and force layout before the next is measured.
  virtualizer.resizeItem = (index, size) => {
    if (!active()) return
    const row = rows()[index]

    if (!row) return
    const key = TimelineRow.key(row)
    const known = growth.target(key) ?? virtualizer.itemSizeCache.get(key)

    if ((known ?? (arrivals.has(key) ? undefined : fallbackItemSize)) === size) {
      pendingSizes.delete(index)

      return
    }

    pendingSizes.set(index, { key, size })

    if (resizeScheduled) return
    resizeScheduled = true
    queueMicrotask(() => {
      resizeScheduled = false

      if (!pendingSizes.size) return
      const sizes = [...pendingSizes]
      pendingSizes.clear()

      if (!active()) return
      // The hidden pinned mount needs one bottom write after the whole batch,
      // not a layout-forcing scroll adjustment for every measured row.
      batchingColdSizes = coldPending && input.pinned()
      batch(() => {
        sizes.forEach(([index, value]) => {
          const row = rows()[index]

          if (!row || TimelineRow.key(row) !== value.key) return
          commitSize(index, value.key, value.size)

          // TanStack recalculates its range after each resize. Advance the
          // logical fold before deciding whether the next row needs anchoring.
          if (!touchAdjustment) return
          setRendering("scrollAdjustment", (value) => value + touchAdjustment)
          touchAdjustment = 0
          const root = listRoot()

          if (root) reportOffset?.(layoutState.offset, virtualizer.isScrolling)
        })
      })
      batchingColdSizes = false
      pinAnchor()

      if (coldPending) pinColdBottom()
      settleColdBottom()

      if (coldPending) return

      if (!input.pinned()) return
      if (following()) return pinEnd()
      const root = listRoot()

      // Reopening a settled scroll-to-end operation can fight subsequent keyboard scrolling.
      if (root && Math.abs(endOffset() - layoutState.offset) > endEpsilon && !following()) virtualizer.scrollToEnd()
    })
  }

  onCleanup(() => pendingSizes.clear())
  // Following stops, or the timeline is put away: growing rows land where the reader left them.
  createEffect(
    on(
      () => input.pinned() && active(),
      (following) => {
        if (!following) landGrowth()
      },
      { defer: true },
    ),
  )
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, delta, instance) => {
    // Prepended rows can resize more than once as deferred content mounts. Keep
    // compensating while they remain entirely above the visible content fold.
    const first = instance.range?.startIndex

    const adjust = addedKeys.has(String(item.key))
      ? item.end <= (instance.scrollOffset ?? 0) + instance.scrollAdjustments + instance.options.scrollMargin
      : first !== undefined && item.index < first

    if (!touchScrolling || input.pinned()) return adjust

    // iOS defers native scroll writes until momentum ends. Keep the same visual
    // anchor now, rather than moving rows now and snapping the viewport back later.
    if (adjust) touchAdjustment += delta

    return false
  }

  function finishTouchScroll() {
    touchScrolling = false
    flushTouchAdjustment()
  }

  // Scrolls to a tool call, named by its ID or by the shell ID a backgrounded shell call reports, and expands it and
  // the collapsed context group that hides it. Returns whether the call is in the list.
  function revealPart(target: string) {
    if (!active()) return false

    const matches = (ref: { messageID: string; partID: string }) => {
      const content = Timeline.resolveContent(input.projection.messageByID().get(ref.messageID), ref.partID)

      return (
        content?.type === "tool" &&
        (content.id === target || (content.state.status !== "streaming" && content.state.metadata?.shellID === target))
      )
    }

    const found = rows()
      .flatMap((row, index) =>
        Predicate.isTagged(row, "AssistantPart")
          ? (row.group.type === "part" ? [row.group.ref] : row.group.refs).flatMap((ref) =>
              matches(ref) ? [{ group: row.group, index, partID: ref.partID }] : [],
            )
          : [],
      )
      .at(-1)

    if (!found) return false

    const key = found.group.key

    prepareNavigation()
    // Opening the group and anchoring its row render the tool synchronously, wherever the row is.
    batch(() => {
      setToolOpen(
        found.group.type === "context"
          ? { [`context:${key}`]: true, [`${key}:tool:${found.partID}`]: true }
          : { [key]: true },
      )
      setRendering("anchor", { key: TimelineRow.key(rows()[found.index]!), partID: found.partID })
    })
    // Until its ResizeObserver delivers, the opened row keeps its collapsed size, so the timeline may not scroll yet
    // (and cannot unpin) or ends above the tool. Commit the real size first.
    const opened = virtualContent?.querySelector<HTMLDivElement>(`[data-index="${found.index}"]`)

    if (opened) resizeItem(found.index, rowHeight(opened))
    input.onUnpin()
    pinAnchor()

    return true
  }

  // Puts the anchored tool's top edge at its scroll margin, just below the headers that stick above it. Its own
  // growth extends downward, so only size changes at or above its row can move it; each of those calls this again.
  function pinAnchor() {
    const anchor = rendering.anchor
    const root = listRoot()

    if (!anchor || !root) return
    const element = virtualContent?.querySelector<HTMLElement>(`[data-timeline-part-id="${CSS.escape(anchor.partID)}"]`)

    // Following the end is a different position to hold.
    if (!element || !active() || input.pinned()) return releaseAnchor()

    const offset = Math.min(
      endOffset(),
      Math.max(
        0,
        layoutState.offset +
          element.getBoundingClientRect().top -
          root.getBoundingClientRect().top -
          parseFloat(getComputedStyle(element).scrollMarginTop),
      ),
    )

    if (Math.abs(offset - layoutState.offset) > 1) virtualizer.scrollToOffset(offset)
  }

  function releaseAnchor() {
    if (rendering.anchor) setRendering("anchor", undefined)
  }

  function prepareNavigation() {
    landGrowth()
    releaseAnchor()

    if (touchStart === undefined) touchScrolling = false
    flushTouchAdjustment()
  }

  function flushTouchAdjustment() {
    const adjustment = rendering.scrollAdjustment
    const root = listRoot()

    if (!adjustment || !root) return
    // Transfer the translation into the native offset in the same paint.
    batch(() => {
      setRendering("scrollAdjustment", 0)

      if (virtualContent) virtualContent.style.height = `${virtualizer.getTotalSize()}px`
      clearRemainder()
      elementScroll(Math.max(0, layoutState.offset + adjustment), {}, virtualizer)
    })
  }

  const virtualItemByKey = createMemo(
    () => new Map(virtualizer.getVirtualItems().map((item) => [item.key, item] as const)),
  )

  const virtualRowKeys = createMemo(() => [
    ...new Set([...virtualizer.getVirtualItems().map((item) => String(item.key)), ...leavingKeys()]),
  ])

  createEffect(() => {
    if (!active()) return
    const root = listRoot()

    if (root) input.setScrollRef(root)

    if (virtualContent) input.setContentRef(virtualContent)
    input.setVisibleRef?.(visibleArea())
    queueMicrotask(() => {
      if (!active() || !root?.isConnected) return
      // A detached view can miss its nonzero ResizeObserver delivery. Publish
      // its real viewport before restoring the offset and admitting rows.
      reportRect?.({ width: root.offsetWidth, height: root.offsetHeight })

      // A route can open this timeline on a tool call, e.g. a shell picked from inside a subagent, instead of its end.
      const target = input.reveal?.target()

      if (target && revealPart(target)) input.reveal?.done()
      else if (input.pinned()) virtualizer.scrollToEnd()

      reportOffset?.(root.scrollTop, false)
      settleColdBottom()
    })
    input.setRevealPart?.(revealPart)
    input.setRevealMessage?.((id, partID) => {
      if (!active()) return

      const partIndex = partID
        ? rows().findIndex(
            (row) =>
              Predicate.isTagged(row, "AssistantPart") && row.group.type === "part" && row.group.ref.partID === partID,
          )
        : -1

      const index = partIndex >= 0 ? partIndex : input.projection.messageRowIndex().get(id)

      if (index === undefined) return
      prepareNavigation()
      virtualizer.scrollToIndex(index, { align: "center" })
    })
    input.setScrollToEnd?.((behavior) => {
      const root = listRoot()

      if (!active() || !root?.isConnected) return

      // Already following its end (sending a prompt resumes it): rows growing in keep growing.
      if (
        behavior !== "smooth" &&
        following() &&
        !rendering.anchor &&
        !rendering.scrollAdjustment &&
        root.scrollHeight - root.clientHeight - root.scrollTop <= 1
      )
        return
      prepareNavigation()
      input.onPin()

      // Glide only the final screen. Crossing the whole history smoothly would stream every row through the virtualizer.
      if (behavior === "smooth")
        virtualizer.scrollToOffset(Math.max(layoutState.offset, endOffset() - layoutState.viewport))
      virtualizer.scrollToEnd({ behavior })
    })
  })

  createEffect(
    on(
      bottomInset,
      (inset, previous) => {
        const root = listRoot()

        if (!active() || !root?.isConnected) return
        reportRect?.(rootRect ?? { width: root.offsetWidth, height: root.offsetHeight })

        if (!input.pinned()) return
        const freed = (previous ?? inset) - inset

        // The composer shrinks while rows grow in at the end (the queue closing as its prompt arrives): the end stays
        // where it is rather than sinking with the composer only to be lifted by the reply. The space it frees is held
        // under the last row for rows arriving below to rise into, and closes once nothing grows.
        if (freed > 0 && following() && growth.growing() && (!shift().size || endGap)) {
          setShift((value) => ({ rows: endGap ? value.rows : rows().length, size: value.size + freed }))
          endGap = true
          growth.hold(freed)
        }

        // The composer region moved its edge: the followed end rides it in the same frame.
        queueMicrotask(pinEnd)
      },
      { defer: true },
    ),
  )

  let settleQueued = false
  let contentObserver: MutationObserver | undefined
  let viewportObserver: ResizeObserver | undefined

  const pinColdBottom = () => {
    if (!active()) return
    const root = listRoot()

    if (!input.pinned() || !virtualContent || !root) return
    // scrollToEnd computes its target from the DOM, not the new size cache.
    virtualContent.style.height = `${virtualizer.getTotalSize()}px`

    pinEnd()

    // Report after core size adjustments finish so they cannot apply a delta
    // twice. This avoids waiting a frame for the native scroll event.
    if (virtualizer.scrollOffset !== layoutState.offset) reportOffset?.(layoutState.offset, false)
  }

  const pendingMeasurements = () => {
    const items = virtualizer.getVirtualItems()

    return (
      (rows().length > 0 && items.length === 0) ||
      items.some((item) => {
        const element = virtualizer.elementsCache.get(item.key)

        // A synchronous attachment read can still see a tool's placeholder.
        // Reveal only after its first browser layout delivery has been committed.
        return !element?.isConnected || (modelHeight(String(item.key)) === undefined && !observedElements.has(element))
      })
    )
  }

  const settleColdBottom = () => {
    if (!active() || !coldPending || settleQueued) return
    settleQueued = true
    queueMicrotask(() => {
      settleQueued = false
      const root = listRoot()

      if (!coldPending || !virtualContent?.isConnected || !root) return
      // A provisional tail can otherwise reveal before the font-ready model fills
      // the rest of history, leaving a pinned session halfway through its final extent.
      if (!layoutState.fontsReady) return
      if (!layoutState.viewport || pendingSizes.size) return

      if (fullyModeled()) {
        // Every offset is known. Commit the extent and pin once, without waiting
        // for row observation, markdown readiness, or an estimated tail reveal.
        setRendering("initialTail", false)
        pinColdBottom()
        coldPending = false
        contentObserver?.disconnect()
        viewportObserver?.disconnect()
        virtualContent.style.removeProperty("visibility")
        return
      }

      if (virtualContent.querySelector(pendingMarkdown)) return

      // Markdown can finish before ResizeObserver delivers its new box. The
      // normal measureElement path skips reads while scrolling; this gate needs
      // current boxes before expanding the estimated range or revealing it.
      virtualizer.elementsCache.forEach((element) => {
        if (element.isConnected) virtualizer.resizeItem(virtualizer.indexFromElement(element), rowHeight(element))
      })

      if (pendingSizes.size || pendingMeasurements()) return
      pinColdBottom()

      if (input.pinned() && Math.abs(endOffset() - layoutState.offset) > 1) return

      // The scroll event must update the range before newly exposed rows can reveal.
      if (endOffset() > 0 && Math.abs((virtualizer.scrollOffset ?? 0) - layoutState.offset) > 1) return

      if (rendering.initialTail) {
        setRendering("initialTail", false)
        settleColdBottom()

        return
      }

      if (pendingSizes.size || pendingMeasurements() || virtualContent.querySelector(pendingMarkdown)) return
      coldPending = false
      contentObserver?.disconnect()
      viewportObserver?.disconnect()
      virtualContent.style.removeProperty("visibility")
    })
  }

  onMount(() => {
    if (!coldPending || !virtualContent) return
    contentObserver = new MutationObserver(settleColdBottom)
    contentObserver.observe(virtualContent, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-markdown-ready"],
    })
    viewportObserver = new ResizeObserver(settleColdBottom)
    const root = listRoot()

    if (root) viewportObserver.observe(root)
    settleColdBottom()
  })

  let measuredSessionKey = input.sessionKey()
  createEffect(() => {
    const key = input.sessionKey()

    if (measuredSessionKey !== key) {
      measuredSessionKey = key
      virtualizer.measure()
    }
  })

  const bindListRoot = (root: HTMLDivElement) => {
    if (root === listRoot()) return
    // TanStack owns anchoring; browser scroll anchoring would fight its adjustments.
    root.style.overflowAnchor = "none"
    setListRoot(root)
    scrollTop = root.scrollTop
    maxScroll = endOffset()

    if (active()) input.setScrollRef(root)
    viewportObserver?.observe(root)
    settleColdBottom()
    let revision = 0
    const refresh = () => {
      const current = ++revision
      const typography = readTimelineTypography(root, current)
      const text = [...input.projection.messageByID().values()]
        .flatMap((message) =>
          message.type === "user"
            ? [message.text]
            : message.type === "assistant"
              ? message.content.flatMap((content) =>
                  content.type === "text" || content.type === "reasoning" ? [content.text] : [],
                )
              : [],
        )
        .join("")
      setLayoutState("environment", undefined)
      setLayoutState("fontsReady", false)
      void Promise.all([
        document.fonts.load(`${typography.weight} ${typography.size}px ${typography.family}`, text),
        document.fonts.load(`${typography.medium} ${typography.size}px ${typography.family}`, text),
        document.fonts.load(`${typography.weight} ${typography.size}px ${typography.codeFamily}`, text),
      ]).then(
        () => {
          if (current !== revision || !root.isConnected) return
          setLayoutState("environment", {
            width: rootRect?.width ?? root.clientWidth,
            desktop: isDesktop(),
            typography,
          })
          setLayoutState("fontsReady", true)
          settleColdBottom()
        },
        () => {
          // A failed face stays on the DOM fallback until the next font/theme change.
          if (current !== revision || !root.isConnected) return
          setLayoutState("fontsReady", true)
          settleColdBottom()
        },
      )
    }
    const observer = new MutationObserver(refresh)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] })
    document.fonts.addEventListener("loadingdone", refresh)
    refresh()
    onCleanup(() => {
      revision++
      observer.disconnect()
      document.fonts.removeEventListener("loadingdone", refresh)
    })
  }

  // Upward input is the one intent geometry cannot recover: nudging up while still a pixel from
  // the end must stop following, even though the resulting position still looks like the end.
  const handleListWheel = (event: WheelEvent & { currentTarget: HTMLDivElement }) => {
    userScrollAt = performance.now()
    releaseAnchor()
    input.onUserScroll(event.target)

    if (event.deltaY < 0) input.onUnpin()
  }

  const handleListTouchStart = (event: TouchEvent) => {
    userScrollAt = performance.now()
    clearTouchTarget()
    releaseAnchor()
    input.onUserScroll(event.target)
    touchScrolling = true
    touchStart = event.touches[0]?.clientY
    const root = listRoot()
    const nested = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-scrollable]") : null
    touchNested = !!nested && nested !== root && nested.scrollHeight > nested.clientHeight
    // Native touch events keep their original target, even when streaming or
    // virtualization detaches it. Listen there instead of relying on bubbling.
    touchTarget = event.target
    touchTarget?.addEventListener("touchmove", handleListTouchMove, { passive: true })
    touchTarget?.addEventListener("touchend", handleListTouchEnd, { passive: true })
    touchTarget?.addEventListener("touchcancel", handleListTouchEnd, { passive: true })

    if (root) reportOffset?.(root.scrollTop, virtualizer.isScrolling)
  }

  const handleListTouchMove = (event: Event) => {
    if (!(event instanceof TouchEvent)) return
    const current = event.touches[0]?.clientY

    if (current === undefined || touchStart === undefined) return
    const previous = touchStart
    touchStart = current

    // A retained target can outlive its whole session view. Only the active
    // timeline may change the shared follow state; release still cleans up below.
    if (!active()) return

    // Dragging the content downward reveals earlier messages.
    if (current <= previous) return

    // A nested scrollport owns the intent. If it chains into the timeline at a
    // boundary, the resulting native timeline scroll below will unpin instead.
    if (touchNested) return
    input.onUnpin()
  }

  const handleListTouchEnd = () => {
    clearTouchTarget()
    touchStart = undefined

    if (!virtualizer.isScrolling) finishTouchScroll()
  }

  function clearTouchTarget() {
    touchTarget?.removeEventListener("touchmove", handleListTouchMove)
    touchTarget?.removeEventListener("touchend", handleListTouchEnd)
    touchTarget?.removeEventListener("touchcancel", handleListTouchEnd)
    touchTarget = null
  }

  onCleanup(clearTouchTarget)

  // Drag-selecting past the edge and dragging the scrollbar both scroll without a wheel or key,
  // so a held pointer is what separates those from the virtualizer's own measurement adjustments.
  const handleListPointerDown = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    releaseAnchor()
    input.onUserScroll(event.target)
    pointerHeld = true
  }

  const releasePointer = () => {
    pointerHeld = false
  }

  onMount(() => {
    window.addEventListener("pointerup", releasePointer)
    window.addEventListener("pointercancel", releasePointer)
  })
  onCleanup(() => {
    window.removeEventListener("pointerup", releasePointer)
    window.removeEventListener("pointercancel", releasePointer)
  })

  const handleListKeyDown = (event: KeyboardEvent & { currentTarget: HTMLDivElement }) => {
    const key = scrollKey(event)

    if (!key) return

    if (!isScrollKeyTarget(event.target, key)) return

    if (scrollKeyOwner(event.currentTarget, event.target, key) !== event.currentTarget) return
    userScrollAt = performance.now()
    releaseAnchor()
    input.onUserScroll(event.currentTarget)

    if (upwardKeys.has(key)) input.onUnpin()
  }

  // Following resumes by arriving at the end, either by scrolling there or by content shrinking
  // under a viewport that was already there. Merely resting near the end is not enough, otherwise
  // a later scroll would overwrite an upward intent expressed a pixel short of the bottom.
  const handleListScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    if (!active()) return
    const root = event.currentTarget
    const previousTop = scrollTop
    const previousMaxScroll = maxScroll
    scrollTop = root.scrollTop
    maxScroll = endOffset()
    setLayoutState("offset", scrollTop)

    // Someone else moved the offset (the user, or the browser clamping it): the drawn remainder no longer applies.
    if (wholeTop !== undefined && scrollTop !== wholeTop) clearRemainder()

    // Content the timeline moves under a resting pointer must not reveal the hover-only footers it passes; the pointer
    // has to move again first. Scrolling the user drives keeps the native behavior.
    if (!pointerHeld && performance.now() - userScrollAt > 250) root.dataset.hoverStale = ""
    const atEnd = maxScroll - scrollTop <= endEpsilon
    const arrived = scrollTop > previousTop + endEpsilon || maxScroll < previousMaxScroll

    // An anchor holds its tool even when reaching it lands at the end; only the user's own scroll lets it go.
    if (maxScroll <= 1 || (atEnd && arrived && !rendering.anchor)) input.onPin()
    else if ((pointerHeld || touchScrolling) && scrollTop < previousTop - endEpsilon) input.onUnpin()
    settleColdBottom()
    input.onScheduleScrollState(root)
    input.onHistoryScroll()
  }

  function View(props: ViewProps) {
    function VirtualRow(rowProps: { rowKey: string }) {
      let element: HTMLDivElement
      const initialItem = virtualItemByKey().get(rowProps.rowKey)!
      const initialRow = rowByKey().get(rowProps.rowKey)!
      const leaving = () => leavingKeys().includes(rowProps.rowKey)
      const item = createMemo<VirtualItem>((previous) => virtualItemByKey().get(rowProps.rowKey) ?? previous, initialItem)
      const row = createMemo<TimelineRow.TimelineRow>((previous) => rowByKey().get(rowProps.rowKey) ?? previous, initialRow)

      const edges = createMemo<{ top: number; bottom: number }>((previous) => {
        if (leaving() && previous) return previous
        const top =
          item().start - topOffset() - rendering.scrollAdjustment - (item().index < shift().rows ? shift().size : 0)

        return { top: grid(top), bottom: grid(top + item().size) }
      })

      const [ready, setReady] = createSignal(initialItem.size <= fallbackItemSize || !props.deferred(initialRow))
      let contentMeasureFrame: number | undefined

      const modeled = createMemo(() => modelHeight(rowProps.rowKey) !== undefined)
      createEffect(() => {
        if (!layoutState.fontsReady) return
        // Opening a modeled compact row can expose a renderer-specific DOM fallback.
        if (!modeled()) return virtualizer.measureElement(element)
        virtualizer.elementsCache.set(rowProps.rowKey, element)
        observedElements.add(element)
        settleColdBottom()
      })
      // Prepending history changes data-index, not the keyed element's identity.
      // Its observer reads the current index and delivers any actual size change.
      onCleanup(() => {
        if (contentMeasureFrame !== undefined) cancelAnimationFrame(contentMeasureFrame)
        queueMicrotask(() => virtualizer.measureElement(null))
      })

      return (
        <div
          data-timeline-key={rowProps.rowKey}
          style={{
            position: "absolute",
            top: `${edges().top}px`,
            left: "0",
            width: "100%",
            height: `${edges().bottom - edges().top}px`,
            overflow: "clip",
            "overflow-clip-margin": Predicate.isTagged(row(), "TurnGap") ? undefined : "0.5px",
          }}
        >
          <div
            ref={(value) => {
              element = value
              const mounted = row()

              if (Predicate.isTagged(mounted, "UserMessage"))
                queueMicrotask(() => {
                  const bubble = value.querySelector<HTMLElement>('[data-slot="user-message-text"]')

                  if (bubble) landSendFlight(mounted.userMessageID, bubble)
                })

              if (
                !Predicate.isTagged(row(), "UserMessage") ||
                !addedKeys.has(rowProps.rowKey) ||
                modeled() ||
                !input.pinned() ||
                coldPending ||
                following()
              )
                return
              // The optimistic row can paint before ResizeObserver corrects the tail estimates.
              // Measure the mounted tail and pin it in this render's microtask instead.
              queueMicrotask(() => {
                if (!input.pinned() || !virtualContent?.isConnected) return
                virtualizer.elementsCache.forEach((item) => {
                  if (item.isConnected) virtualizer.resizeItem(virtualizer.indexFromElement(item), rowHeight(item))
                })
                virtualizer.resizeItem(item().index, rowHeight(element))
                virtualContent.style.height = `${virtualizer.getTotalSize()}px`
                virtualizer.scrollToEnd()
              })
            }}
<<<<<<< HEAD
            data-index={leaving() ? -1 : item().index}
            style={{ "min-height": ready() ? undefined : `${initialItem.size}px` }}
||||||| parent of ba5527bd24 (feat(app): measure timeline rows with pretext)
            data-index={item().index}
            style={{ "min-height": ready() ? undefined : `${initialItem.size}px` }}
=======
            data-index={item().index}
            style={{ "min-height": ready() || modeled() ? undefined : `${initialItem.size}px` }}
>>>>>>> ba5527bd24 (feat(app): measure timeline rows with pretext)
          >
            {props.renderRow(row, () => {
              setReady(true)

              if (contentMeasureFrame !== undefined) cancelAnimationFrame(contentMeasureFrame)
              if (modeled()) return
              contentMeasureFrame = requestAnimationFrame(() => {
                contentMeasureFrame = undefined

                if (active() && element.isConnected) virtualizer.measureElement(element)
              })
            })}
          </div>
        </div>
      )
    }

    return (
      <div
        ref={setViewRoot}
        class="relative w-full h-full min-w-0"
        style={{
          "--session-timeline-inset": `${bottomInset()}px`,
        }}
      >
        <div
          class="absolute bottom-[calc(var(--session-timeline-inset)+32px)] left-1/2 -translate-x-1/2 z-[60] pointer-events-none transition-[opacity,translate]"
          classList={{
            "opacity-100 translate-y-0 duration-150 ease-[cubic-bezier(.2,.8,.2,1)]":
              input.scroll().overflow && input.scroll().jump,
            "opacity-0 translate-y-1 motion-reduce:translate-y-0 duration-[110ms] ease-[cubic-bezier(.4,0,1,1)]":
              !input.scroll().overflow || !input.scroll().jump,
          }}
          inert={!input.scroll().overflow || !input.scroll().jump}
        >
          <button
            type="button"
            aria-label={language.t("session.messages.jumpToLatest")}
            class="pointer-events-auto flex items-center justify-center w-8 h-7 px-2 py-1.5 rounded-lg border-none cursor-pointer text-v2-text-text-base backdrop-blur-[2px] outline-none hover:bg-[linear-gradient(var(--v2-overlay-simple-overlay-hover),var(--v2-overlay-simple-overlay-hover))] active:bg-[linear-gradient(var(--v2-overlay-simple-overlay-pressed),var(--v2-overlay-simple-overlay-pressed))] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-border-border-focus"
            style={{
              "background-color": "color-mix(in srgb, var(--v2-background-bg-base) 92%, transparent)",
              "box-shadow": "var(--v2-elevation-raised), 0px 2px 8px var(--v2-background-bg-base)",
            }}
            onClick={() => input.onResumeScroll(prefersReducedMotion() ? "auto" : "smooth")}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M12.3333 8.66665L8 13L3.66667 8.66665M8 12.6667V2.83332"
                stroke="currentColor"
                stroke-linecap="square"
              />
            </svg>
          </button>
        </div>
        <ScrollView
          data-slot="session-timeline-scroll"
          viewportRef={bindListRoot}
          thumbContainer={visibleArea()}
          thumbHoverTarget={viewRoot()}
          onBeforeScroll={prepareNavigation}
          verticalScrollAdjustment={rendering.scrollAdjustment}
          verticalGeometry={scrollGeometry()}
          onWheel={handleListWheel}
          onTouchStart={handleListTouchStart}
          onPointerDown={handleListPointerDown}
          onPointerMove={(event) => delete event.currentTarget.dataset.hoverStale}
          onKeyDown={handleListKeyDown}
          onScroll={handleListScroll}
          onClick={input.onSelectionInteraction}
          class="relative min-w-0 w-full h-full"
          style={{ "--sticky-accordion-top": input.showHeader() ? "var(--session-header-height, 48px)" : "0px" }}
        >
          <Show when={input.showHeader()} fallback={<div aria-hidden="true" class="h-4 md:hidden" />}>
            {props.header}
          </Show>
          <div
            data-timeline-virtual-content
            ref={(element) => {
              virtualContent = element

              if (active()) input.setContentRef(element)
            }}
            style={{
              height: `${virtualizer.getTotalSize() - rendering.scrollAdjustment}px`,
              position: "relative",
              width: "100%",
              visibility: coldBottomMount ? "hidden" : undefined,
            }}
          >
            <For each={virtualRowKeys()}>{(rowKey) => <VirtualRow rowKey={rowKey} />}</For>
            <div
              data-timeline-row="bottom-spacer"
              class="absolute top-0 left-0 w-full"
              style={{
                height: `${tailSize}px`,
                transform: `translateY(${virtualizer.getTotalSize() - tailSize - rendering.scrollAdjustment}px)`,
              }}
            >
              {props.bottomSpacer}
            </div>
          </div>
          <div
            ref={insetSpacer}
            aria-hidden="true"
            data-timeline-inset
            class="h-[var(--session-timeline-inset)] shrink-0"
          />
        </ScrollView>
        <div
          ref={setVisibleArea}
          data-slot="session-timeline-visible"
          class="pointer-events-none absolute inset-x-0 top-0 bottom-[var(--session-timeline-inset)]"
        />
      </div>
    )
  }

  onCleanup(() => {
    landGrowth()
    cache.delete(ownerSessionKey)
    cache.set(ownerSessionKey, {
      measurements: virtualizer.takeSnapshot(),
      toolOpen: { ...toolOpen },
      patchGroupKeys,
      presentationKey: input.presentationKey?.(),
    })

    while (cache.size > 16) cache.delete(cache.keys().next().value!)
    coldPending = false
    contentObserver?.disconnect()
    viewportObserver?.disconnect()

    if (active()) {
      input.setScrollRef(undefined)
      input.setRevealMessage?.(() => {})
      input.setRevealPart?.(() => false)
      input.setScrollToEnd?.(() => {})
    }
  })

  return {
    disclosure: {
      patchGroupKeys,
      value: (key: string) => toolOpen[key],
      set: (key: string, open: boolean) => setToolOpen(key, open),
    },
    revealPart,
    View,
  }
}
