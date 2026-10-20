import { frameLoop, prefersReducedMotion, Spring } from "@opencode/ui/motion"
import { growthSpring } from "./row-growth"

type Rect = { x: number; y: number; w: number; h: number }

type Flight = { text: HTMLElement; layer: HTMLElement; from: Rect; expire: ReturnType<typeof setTimeout> }

// The sent text rises from behind the composer, clipped to its timeline's visible viewport. The real bubble stays
// hidden until the flight lands on it.
const waiting = new Map<string, Flight>()

/** Holds a copy of the composer's text where it is, before the composer clears, for the bubble that `id` becomes. */
export function prepareSendFlight(id: string, editor: HTMLElement | undefined) {
  if (!editor?.isConnected || prefersReducedMotion()) return
  const range = document.createRange()
  range.selectNodeContents(editor)
  const box = range.getBoundingClientRect()

  if (box.width < 1 || box.height < 1) return
  const style = getComputedStyle(editor)
  const text = document.createElement("div")
  text.setAttribute("aria-hidden", "true")
  Object.assign(text.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: `${Math.ceil(box.width) + 1}px`,
    transformOrigin: "0 0",
    transform: `translate3d(${box.left}px, ${box.top}px, 0)`,
    font: style.font,
    letterSpacing: style.letterSpacing,
    color: style.color,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  })
  editor.childNodes.forEach((node) => text.append(node.cloneNode(true)))
  text.querySelectorAll("[contenteditable]").forEach((node) => node.removeAttribute("contenteditable"))

  const layer = document.createElement("div")
  layer.setAttribute("aria-hidden", "true")
  layer.dataset.sendFlight = ""
  Object.assign(layer.style, {
    position: "absolute",
    inset: "0",
    pointerEvents: "none",
    zIndex: "1",
    contain: "strict",
    overflow: "hidden",
    // The destination supplies its viewport before the copy may paint.
    visibility: "hidden",
  })
  document.body.append(layer)

  layer.append(text)
  waiting.get(id)?.layer.remove()
  waiting.set(id, {
    text,
    layer,
    from: { x: box.left, y: box.top, w: box.width, h: box.height },
    expire: setTimeout(() => {
      waiting.delete(id)
      text
        .animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: 110,
          easing: "cubic-bezier(.4,0,1,1)",
          fill: "forwards",
        })
        .finished.finally(() => layer.remove())
    }, 700),
  })
}

/** Flies the waiting copy for `id` onto `bubble`. Returns false when nothing was waiting for it. */
export function landSendFlight(id: string, bubble: HTMLElement) {
  const flight = waiting.get(id)

  if (!flight) return false
  waiting.delete(id)
  clearTimeout(flight.expire)

  if (prefersReducedMotion()) {
    flight.layer.remove()

    return false
  }

  const style = getComputedStyle(bubble)
  const viewport = bubble
    .closest('[data-slot="session-timeline-scroll"]')
    ?.parentElement?.querySelector<HTMLElement>('[data-slot="session-timeline-visible"]')

  if (!viewport) {
    flight.layer.remove()

    return false
  }
  viewport.append(flight.layer)
  const left = parseFloat(style.paddingLeft) || 0
  const right = parseFloat(style.paddingRight) || 0
  const top = parseFloat(style.paddingTop) || 0
  const bottom = parseFloat(style.paddingBottom) || 0

  const start = {
    x: flight.from.x - left,
    y: flight.from.y - top,
    w: flight.from.w + left + right,
    h: flight.from.h + top + bottom,
  }

  const host = document.createElement("div")
  host.setAttribute("aria-hidden", "true")
  host.dataset.component = "user-message"
  host.dataset.flight = ""
  Object.assign(host.style, { position: "fixed", left: "0", top: "0", transformOrigin: "0 0", opacity: "0" })
  // SAFETY: a deep clone has the same element type as its source.
  const copy = bubble.cloneNode(true) as HTMLElement
  Object.assign(copy.style, { width: "100%", height: "100%", margin: "0", boxSizing: "border-box" })
  host.append(copy)
  flight.text.before(host)
  bubble.style.opacity = "0"

  const spring = Spring.fromDuration(0, growthSpring()).set(1)
  let last: DOMRect | undefined
  let rect = bubble.getBoundingClientRect()
  let clip = viewport.getBoundingClientRect()

  const land = () => {
    bubble.style.removeProperty("opacity")
    flight.layer.remove()
  }

  frameLoop.addMeasured(
    () => {
      last = rect
      rect = bubble.getBoundingClientRect()
      clip = viewport.getBoundingClientRect()
    },
    (dt) => {
      if (!bubble.isConnected || !viewport.isConnected || rect.width < 1) {
        land()

        return false
      }

      const p = spring.step(dt)
      flight.layer.style.visibility = "visible"
      const at = mix(start, { x: rect.left, y: rect.top, w: rect.width, h: rect.height }, p)
      host.style.width = `${rect.width}px`
      host.style.height = `${rect.height}px`
      host.style.transform = `translate3d(${at.x - clip.left}px, ${at.y - clip.top}px, 0) scale(${at.w / rect.width}, ${at.h / rect.height})`
      host.style.opacity = `${Math.min(1, p / 0.5)}`

      const words = mix(
        flight.from,
        { x: rect.left + left, y: rect.top + top, w: rect.width - left - right, h: flight.from.h },
        p,
      )

      flight.text.style.transform = `translate3d(${words.x - clip.left}px, ${words.y - clip.top}px, 0)`
      flight.text.style.opacity = `${Math.max(0, 1 - p / 0.4)}`

      if (!spring.resting || !last || Math.abs(last.top - rect.top) > 0.5 || Math.abs(last.left - rect.left) > 0.5)
        return true
      land()

      return false
    },
  )

  return true
}

function mix(a: Rect, b: Rect, p: number): Rect {
  return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p, w: a.w + (b.w - a.w) * p, h: a.h + (b.h - a.h) * p }
}
