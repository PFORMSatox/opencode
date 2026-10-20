import {
  createComputed,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  Show,
  type Accessor,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import { Predicate } from "effect"
import type { SessionUserActions } from "@opencode/session-ui/actions"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { InlineInput } from "@opencode/ui/inline-input"
import { Keybind } from "@opencode/ui/keybind"
import { Menu } from "@opencode/ui/menu"
import { TextShimmer } from "@opencode/ui/text-shimmer"
import type { BackgroundTask, MountedSession, SessionScreen } from "@opencode/gui-extensions/sdk"
import { ExtensionSlot } from "@/runtime/extension/render"
import { useLanguage } from "@/runtime/i18n/language"
import { useServer } from "@/runtime/server/current"
import { useWorkspaceLocation } from "@/workspaces/location"
import { Timeline } from "@opencode/session-ui/timeline/projection"
import { createSessionTimelineRowRenderer } from "@opencode/session-ui/timeline/row"
import { getReadyMarkdown, preloadMarkdown } from "@opencode/session-ui/markdown-cache"
import { createTimelineController, type TimelineController, type TimelineSessionSource } from "./controller"
import { createTimelineVirtualizer } from "./virtualizer"
import { containsDirectory } from "@opencode/util/path"
import { isWorkspaceDirectory } from "@/workspaces/paths"
import { parseCommentNote, readPromptPresentation } from "@/composer/comment-note"
import { parseVoiceDelegation } from "./voice-delegation"
import { useCommand } from "@/shell/commands/command"
import {
  SessionAncestorTrail,
  SessionHeaderLayout,
  SessionLocation,
  SessionTitleHeader,
} from "../session-identity-header"
import { SessionHeaderSpacer } from "@/session/header/session-header"
import { SessionWorkingIndicator } from "@/session/header/session-working-indicator"

type BlockingTask = { type: "shell" | "subagent"; partID: string; id?: string; label?: string }

type SessionBackground = {
  blocking: Accessor<BlockingTask[]>
  tasks: Accessor<readonly BackgroundTask[]>
  move: () => Promise<void>
}

export function BackgroundMoveHint(props: { keybind?: string[]; onMove?: () => void }) {
  const language = useLanguage()
  const command = useCommand()
  const keys = () => props.keybind ?? command.keybindParts("session.background")
  const keybind = () => props.keybind?.join("+") ?? command.keybind("session.background")

  return (
    <Button
      data-component="session-background-hint"
      type="button"
      variant="ghost-faint"
      size="small"
      class="max-w-full"
      aria-label={language.t("session.background.moveInline", { keybind: keybind() })}
      onClick={() => props.onMove?.()}
    >
      <span class="min-w-0 truncate">{language.t("session.background.moveRunning")}</span>
      <Keybind keys={keys()} variant="neutral" />
    </Button>
  )
}

type MessageTimelineProps = {
  hideHeader?: boolean
  active?: boolean
  session: TimelineSessionSource
  view: MountedSession
  screen: SessionScreen
  background: SessionBackground
  actions?: SessionUserActions
  scroll: { overflow: boolean; jump: boolean }
  onResumeScroll: (behavior?: ScrollBehavior) => void
  setScrollRef: (el: HTMLDivElement | undefined) => void
  onScheduleScrollState: (el: HTMLDivElement) => void
  onPin: () => void
  onUnpin: () => void
  onUserScroll: (target?: EventTarget | null) => void
  onHistoryScroll: () => void
  onSelectionInteraction: (event: MouseEvent) => void
  pinned: boolean
  centered: boolean
  reserveReviewToggle: boolean
  setContentRef: (el: HTMLDivElement) => void
  bottomInset?: number
  setVisibleRef?: (el: HTMLDivElement | undefined) => void
  anchor: (id: string) => string
  setRevealMessage?: (fn: (id: string, partID?: string) => void) => void
  setRevealPart?: (fn: (target: string) => boolean) => void
  setScrollToEnd?: (fn: (behavior?: ScrollBehavior) => void) => void
  reveal?: { target: () => string | undefined; done: () => void }
  search?: JSX.Element
}

export function MessageTimeline(props: MessageTimelineProps) {
  const controller = createTimelineController({ session: props.session })
  const tail = props.pinned ? controller.data.projection.rows().at(-1) : undefined

  if (tail?._tag === "AssistantPart" && tail.group.type === "part") {
    const message = controller.data.projection.messageByID().get(tail.group.ref.messageID)

    if (message?.type === "assistant" && message.time.completed !== undefined) {
      const content = Timeline.resolveContent(message, tail.group.ref.partID)

      // Start the required worker job while the rest of the selected view is constructed.
      if (content?.type === "text" && content.text.trim()) {
        const preload = new AbortController()
        onCleanup(() => preload.abort())
        void preloadMarkdown(content.text, tail.group.ref.partID, preload.signal).catch(() => undefined)
      }
    }
  }

  // Motion state belongs to one session; another one starts from a fresh view.
  return (
    <Show when={controller.data.sessionID()} keyed>
      {(_id) => (
        <MessageTimelineView
          {...props}
          data={controller.data}
          action={controller.action}
          pending={controller.pending}
        />
      )}
    </Show>
  )
}

function MessageTimelineView(
  props: MessageTimelineProps & {
    data: TimelineController["data"]
    action: TimelineController["action"]
    pending: TimelineController["pending"]
  },
) {
  const language = useLanguage()
  const server = useServer()
  const data = server.ctx.data
  const sdk = useWorkspaceLocation()
  const sessionID = props.data.sessionID
  const sessionStatus = props.data.status
  const titleLabel = props.data.titleLabel
  const parentID = props.data.parentID
  const parentTitle = props.data.parentTitle
  const childTitle = props.data.childTitle
  const projection = props.data.projection
  const sessionDirectory = createMemo(() => props.session.data.info()?.location.directory ?? sdk().directory)

  const project = createMemo(() => {
    const session = props.session.data.info()
    const projects = server.ctx.sync.data.project

    return session
      ? server.ctx.projects.forSession(session)
      : projects.find((item) => containsDirectory(item.worktree, sessionDirectory()))
  })

  const workspaceSession = createMemo(() => isWorkspaceDirectory(project(), sessionDirectory()))

  const headerProject = createMemo(() => {
    const session = props.session.data.info()

    if (!session) return

    return server.ctx.projects.forSession(session)
  })

  createEffect(() => {
    const directory = project()?.worktree

    if (!directory) return
    void data.location.vcs.sync({ directory }).catch(() => undefined)
  })
  const turnPadding = () => "px-4 md:px-6"
  const showHeader = createMemo(() => !props.hideHeader && (props.data.showHeader() || workspaceSession()))
  const pinned = createMemo(() => props.pinned)
  const messageByID = projection.messageByID

  const virtualized = createTimelineVirtualizer({
    active: () => props.active !== false,
    sessionKey: () => `${server.key}/${props.data.sessionID()}`,
    presentationKey: () => JSON.stringify(props.data.timelineDetail()),
    projection,
    showHeader,
    layout: (row, environment) =>
      row._tag === "Activity" ? { source: "fixed", height: 36 } : rowRenderer.layout(row, environment),
    pinned,
    scroll: () => props.scroll,
    onResumeScroll: props.onResumeScroll,
    setScrollRef: props.setScrollRef,
    setContentRef: props.setContentRef,
    bottomInset: () => props.bottomInset ?? 0,
    setVisibleRef: props.setVisibleRef,
    onScheduleScrollState: props.onScheduleScrollState,
    onPin: props.onPin,
    onUnpin: props.onUnpin,
    onSelectionInteraction: props.onSelectionInteraction,
    onUserScroll: props.onUserScroll,
    onHistoryScroll: props.onHistoryScroll,
    canRenderImmediately: (row, disclosure) => {
      if (
        Predicate.isTagged(row, "TurnGap") ||
        Predicate.isTagged(row, "TurnDivider") ||
        Predicate.isTagged(row, "CompactionQueued") ||
        Predicate.isTagged(row, "Activity")
      )
        return true

      if (Predicate.isTagged(row, "Notice")) {
        const message = messageByID().get(row.messageID)

        return (
          (message?.type === "system" || message?.type === "synthetic") &&
          (message.description ?? message.text).length <= 1024
        )
      }

      if (Predicate.isTagged(row, "UserMessage")) {
        const message = messageByID().get(row.userMessageID)

        if (message?.type !== "user" || message.text.length > 1024 || message.files?.length || message.agents?.length)
          return false
        const presentation = readPromptPresentation(message.metadata)

        return (
          (presentation?.displayText ?? message.text).length <= 1024 &&
          !presentation?.comments?.length &&
          !presentation?.attachments.length &&
          !parseCommentNote(message.text)
        )
      }

      if (!Predicate.isTagged(row, "AssistantPart") || row.group.type !== "part") return false
      const message = messageByID().get(row.group.ref.messageID)

      if (message?.type !== "assistant" || message.time.completed === undefined) return false
      const content = Timeline.resolveContent(message, row.group.ref.partID)

      if (content?.type === "reasoning")
        return !(disclosure[row.group.ref.partID] ?? props.data.reasoningMode() === "full")

      return (
        content?.type === "text" &&
        content.text.length <= 1024 &&
        !!getReadyMarkdown({ raw: content.text, src: content.text }, `${row.group.ref.partID}:0:full`)
      )
    },
    setRevealMessage: props.setRevealMessage,
    setRevealPart: props.setRevealPart,
    setScrollToEnd: props.setScrollToEnd,
    reveal: props.reveal,
  })

  const VirtualizedTimeline = virtualized.View

  const [title, setTitle] = createStore({
    draft: "",
    editing: false,
    menuOpen: false,
    pendingRename: false,
  })

  let titleRef: HTMLInputElement | undefined

  createEffect(
    on(
      props.data.sessionKey,
      () =>
        setTitle({
          draft: "",
          editing: false,
          menuOpen: false,
          pendingRename: false,
        }),
      { defer: true },
    ),
  )

  const openTitleEditor = () => {
    if (!sessionID() || parentID()) return
    setTitle({ editing: true, draft: titleLabel() ?? "" })
    requestAnimationFrame(() => {
      if (!titleRef) return
      titleRef.focus()
      titleRef.select()
    })
  }

  const closeTitleEditor = () => {
    if (props.pending.rename()) return
    setTitle("editing", false)
  }

  const saveTitleEditor = async () => {
    if (!title.editing || props.pending.rename()) return

    if (await props.action.rename(title.draft)) setTitle("editing", false)
  }

  createEffect(() => {
    if (props.active !== false) return
    setTitle({ draft: "", editing: false, menuOpen: false, pendingRename: false })
  })

  const rowRenderer = createSessionTimelineRowRenderer({
    sessionID: () => sessionID()!,
    status: sessionStatus,
    projection,
    presentation: (message) => {
      const value = readPromptPresentation(message.metadata)
      const parsed = value ? undefined : parseCommentNote(message.text)
      const voice = parseVoiceDelegation(value?.displayText ?? message.text)

      return {
        displayText: voice ? (voice.framing ?? voice.instruction) : value?.displayText,
        comments: value?.comments ?? (parsed ? [parsed] : []),
        references: value?.attachments,
        voice: !!voice,
      }
    },
    actions: props.actions,
    reasoningMode: props.data.reasoningMode,
    shellToolDefaultOpen: props.data.shellToolPartsExpanded,
    editToolDefaultOpen: props.data.editToolPartsExpanded,
    timelineDetail: props.data.timelineDetail,
    disclosure: virtualized.disclosure,
    centered: () => props.centered,
    padding: turnPadding,
    anchor: props.anchor,
  })

  const backgroundHintPartID = createMemo(() => {
    const blocking = new Set(props.background.blocking().map((task) => task.partID))

    if (blocking.size === 0) return

    return projection
      .rows()
      .flatMap((row) =>
        Predicate.isTagged(row, "AssistantPart") ? (row.group.type === "part" ? [row.group.ref] : row.group.refs) : [],
      )
      .findLast((ref) => blocking.has(ref.partID))?.partID
  })

  const showWorking = createMemo(() => {
    const id = sessionID()

    if (!id || sessionStatus().type !== "busy") return false

    if (data.session.permission.list(id)?.length || data.session.form.list(id)?.length) return false
    const active = projection.activeMessageID()

    if (!active) return false
    const assistant = projection.assistantMessagesByParent().get(active)?.at(-1)

    if (assistant?.retry) return false

    // Pending steers still project under the previous response until delivery.
    // Its error must not hide feedback for a newly submitted prompt.
    if (
      assistant?.error &&
      !data.session.pending.list(id).some((item) => item.type === "user" && item.delivery === "steer")
    )
      return false
    const content = assistant?.content.at(-1)

    if (
      assistant?.time.completed === undefined &&
      assistant?.time.streamed === undefined &&
      content?.type === "text" &&
      content.text.trim()
    )
      return false
    const background = new Set(props.background.tasks().map((task) => task.id))

    return !projection.rows().some((row) => {
      if (row.userMessageID !== active) return false

      if (Predicate.isTagged(row, "Thinking")) return true

      if (Predicate.isTagged(row, "Notice")) {
        const message = messageByID().get(row.messageID)

        return message?.type === "compaction" && message.status === "running"
      }

      // Used and read groups keep the fallback, so each new read does not swap Working out for its short call.
      if (!Predicate.isTagged(row, "AssistantPart") || row.group.type === "context" || row.group.type === "read")
        return false

      return (row.group.type === "part" ? [row.group.ref] : row.group.refs).some((ref) => {
        const content = Timeline.resolveContent(messageByID().get(ref.messageID), ref.partID)

        if (content?.type !== "tool") return false

        if (content.state.status === "streaming" || content.state.status === "running") return true
        const taskID = content.state.metadata?.[content.name === "subagent" ? "sessionID" : "shellID"]

        return background.has(content.id) || (Predicate.isString(taskID) && background.has(taskID))
      })
    })
  })

  // Undelivered input waits below the work the model has seen, so live status moves into the row above it.
  const activityRow = createMemo(() => projection.rows().some((row) => Predicate.isTagged(row, "Activity")))
  // Set before the move renders, so the lane it moves to sees it.
  let movedAt = -Infinity
  createComputed(on(activityRow, () => (movedAt = performance.now()), { defer: true }))

  // Live status shows in one lane at a time. The lane it leaves fades it out where it was; the lane it moves to fades
  // it in once that is done, so it never shows twice. The lane keeps its height while empty, so Working and the hint
  // come and go without moving the rows around it.
  function ActivityLane(lane: { here: () => boolean }) {
    // Taking over from the other lane, status fades in once the copy there has faded out.
    const delay = () => (performance.now() - movedAt < 100 ? 110 : undefined)
    const working = createStatusFade(() => lane.here() && showWorking(), delay)
    const hint = createStatusFade(() => lane.here() && !!backgroundHintPartID(), delay, 1000)
    // Working keeps its width until a hint beside it leaves, so the hint never jumps sideways.
    const holdWorking = createMemo<boolean>((held) => working.present() || Boolean(held && hint.present()))

    return (
      <div
        classList={{
          "min-w-0 w-full max-w-full": true,
          "md:max-w-session md:mx-auto": props.centered,
        }}
      >
        <div class={`flex h-9 items-center gap-2 pt-3 text-[13px] font-[530] leading-text-compact ${turnPadding()}`}>
          <Show when={holdWorking()}>
            <div
              ref={working.ref}
              data-component={working.present() ? "session-working" : undefined}
              role={working.present() ? "status" : undefined}
              aria-hidden={!working.present() || undefined}
              classList={{ "invisible pointer-events-none": !working.present() }}
            >
              <TextShimmer text={language.t("session.timeline.working")} active />
            </div>
          </Show>
          <Show when={hint.present()}>
            <div ref={hint.ref} data-component="session-background-hint-row">
              <BackgroundMoveHint onMove={props.background.move} />
            </div>
          </Show>
        </div>
      </div>
    )
  }

  return (
    <VirtualizedTimeline
      bottomSpacer={<ActivityLane here={() => !activityRow()} />}
      deferred={(row) => {
        if (!Predicate.isTagged(row, "AssistantPart") || row.group.type !== "part") return false
        const content = Timeline.resolveContent(messageByID().get(row.group.ref.messageID), row.group.ref.partID)

        return content?.type === "tool" && ["edit", "write"].includes(content.name)
      }}
      renderRow={(row, onSizeChange) => (
        <Show
          when={Predicate.isTagged(row(), "Activity")}
          fallback={<rowRenderer.Row row={row} onSizeChange={onSizeChange} />}
        >
          <ActivityLane here={() => true} />
        </Show>
      )}
      header={
        <Show when={!props.hideHeader}>
          <SessionTitleHeader>
            <SessionHeaderLayout
              location={
                <>
                  <SessionLocation
                    project={headerProject()}
                    directory={sessionDirectory()}
                    compact={!!parentID()}
                    trailing={!!(parentID() || childTitle() || title.editing)}
                  />
                  <Show when={parentID()}>
                    {(id) => (
                      <SessionAncestorTrail
                        sessionID={sessionID() ?? ""}
                        parentID={id()}
                        parentTitle={parentTitle()}
                        trailing={!!(childTitle() || title.editing)}
                      />
                    )}
                  </Show>
                </>
              }
              actions={
                <Show when={sessionID()} keyed>
                  {(_id) => (
                    <>
                      {props.search}
                      <ExtensionSlot
                        at="session.header"
                        input={{
                          get session() {
                            return props.view
                          },
                          get screen() {
                            return props.screen
                          },
                          get active() {
                            return props.active !== false
                          },
                        }}
                      />
                      <SessionHeaderSpacer visible={props.reserveReviewToggle} />
                    </>
                  )}
                </Show>
              }
            >
              <Show when={parentID() && childTitle()}>
                {(value) => (
                  <>
                    <SessionWorkingIndicator sessionID={sessionID()} />
                    <h1
                      data-slot="session-title-child"
                      dir="auto"
                      class="max-w-[45%] shrink-0 w-fit truncate rounded-[6px] px-1 py-1 text-[13px] font-[530] leading-4 tracking-[-0.04px] text-v2-text-text-base"
                    >
                      {value()}
                    </h1>
                  </>
                )}
              </Show>
              <Show when={!parentID() && (childTitle() || title.editing)}>
                <Show
                  when={title.editing}
                  fallback={
                    <h1
                      data-slot="session-title-child"
                      class="truncate text-[13px] font-[530] leading-4 tracking-[-0.04px] text-v2-text-text-base w-fit rounded-[6px] px-1 py-1 hover:bg-v2-overlay-simple-overlay-hover"
                      classList={{ "max-w-[45%] shrink-0": !!parentID() }}
                      onClick={openTitleEditor}
                    >
                      {childTitle()}
                    </h1>
                  }
                >
                  <InlineInput
                    ref={(el) => {
                      titleRef = el
                    }}
                    data-slot="session-title-child"
                    dir="auto"
                    value={title.draft}
                    disabled={props.pending.rename()}
                    class="block text-[13px] font-[530] leading-4 tracking-[-0.04px] text-v2-text-text-base field-sizing-content rounded-[6px] px-1 py-1"
                    classList={{ "max-w-[45%] shrink-0": !!parentID() }}
                    style={{
                      "--inline-input-shadow": "none",
                      "text-align": "start",
                    }}
                    onInput={(event) => setTitle("draft", event.currentTarget.value)}
                    onKeyDown={(event) => {
                      event.stopPropagation()

                      if (event.isComposing || event.keyCode === 229) return

                      if (event.key === "Enter") {
                        event.preventDefault()
                        void saveTitleEditor()

                        return
                      }

                      if (event.key === "Escape") {
                        event.preventDefault()
                        closeTitleEditor()
                      }
                    }}
                    onBlur={() => void saveTitleEditor()}
                  />
                </Show>
              </Show>
              <Show when={!parentID() && sessionID()} keyed>
                {(id) => (
                  <Menu
                    gutter={6}
                    placement="bottom-start"
                    open={title.menuOpen}
                    onOpenChange={(open) => setTitle("menuOpen", open)}
                  >
                    <Menu.Trigger
                      as={IconButton}
                      icon={<Icon name="outline-dots" />}
                      variant="ghost-muted"
                      size="large"
                      class="shrink-0"
                      aria-label={language.t("common.moreOptions")}
                      aria-expanded={title.menuOpen}
                    />
                    <Menu.Portal>
                      <Menu.Content
                        class="session-options-menu w-max"
                        style={{ "min-width": "0" }}
                        onCloseAutoFocus={(event) => {
                          if (!title.pendingRename) return
                          event.preventDefault()
                          setTitle("pendingRename", false)
                          openTitleEditor()
                        }}
                      >
                        <Show when={!parentID()}>
                          <Menu.Item
                            onSelect={() => {
                              setTitle("pendingRename", true)
                              setTitle("menuOpen", false)
                            }}
                          >
                            {language.t("common.rename")}
                          </Menu.Item>
                          <Menu.Item onSelect={() => void props.action.export(id)}>
                            {language.t("common.export")}…
                          </Menu.Item>
                        </Show>
                        <Show when={!parentID()}>
                          {/* TODO: Need a session archive API. */}
                          <Menu.Separator />
                          <Menu.Item onSelect={() => props.action.showDelete(id)}>
                            {language.t("common.delete")}…
                          </Menu.Item>
                        </Show>
                      </Menu.Content>
                    </Menu.Portal>
                  </Menu>
                )}
              </Show>
            </SessionHeaderLayout>
          </SessionTitleHeader>
        </Show>
      }
    />
  )
}

// Status fades in and out from whatever opacity it has reached, so a flicker or a quick return never cuts it short.
// Present when it mounts, it starts at rest; `hold` keeps it at least that long once shown.
function createStatusFade(show: Accessor<boolean>, delay: () => number | undefined, hold = 0) {
  const [present, setPresent] = createSignal(show())
  let element: HTMLElement | undefined
  let fade: Animation | undefined
  let shownAt = performance.now()
  let entering = false

  const run = (visible: boolean, wait = 0) => {
    if (!element) return !visible && setPresent(false)
    const from = entering ? "0" : getComputedStyle(element).opacity
    entering = false
    fade?.cancel()

    const current = element.animate([{ opacity: from }, { opacity: visible ? 1 : 0 }], {
      duration: visible ? 150 : 110,
      delay: wait,
      easing: visible ? "cubic-bezier(.2,.8,.2,1)" : "cubic-bezier(.4,0,1,1)",
      fill: "both",
    })

    fade = current
    current.finished.then(
      () => fade === current && !visible && setPresent(false),
      () => undefined,
    )
  }

  createEffect(
    on(
      show,
      (visible) => {
        if (visible) shownAt = performance.now()

        if (visible && !present()) {
          entering = true

          return setPresent(true)
        }

        const remaining = visible ? 0 : hold - (performance.now() - shownAt)

        if (remaining <= 0) return run(visible)
        const timer = setTimeout(() => run(false), remaining)
        onCleanup(() => clearTimeout(timer))
      },
      { defer: true },
    ),
  )
  onCleanup(() => fade?.cancel())

  return {
    present,
    ref(value: HTMLElement) {
      element = value
      const wait = delay()

      if (entering || (wait !== undefined && show())) {
        entering = true
        run(true, wait)
      }
    },
  }
}
