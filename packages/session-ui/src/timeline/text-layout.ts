import { clearCache, layout, measureNaturalWidth, prepare, type PreparedText } from "@chenglou/pretext"
import { measureRichInlineStats, prepareRichInline, type RichInlineItem } from "@chenglou/pretext/rich-inline"

/** Resolved CSS values, read when the viewport's typography changes, never once per row. */
export type TimelineTypography = {
  family: string
  codeFamily: string
  codeInset: number
  rem: number
  size: number
  weight: number
  medium: number
  bold: number
  lineHeight: number
  letterSpacing: number
  revision: number
}

export type TimelineRowLayout =
  | { source: "pretext" | "fixed"; height: number }
  | { source: "dom"; reason: string; blocks?: number[] }

export type TimelineLayoutEnvironment = {
  width: number
  desktop: boolean
  typography: TimelineTypography
}

export function readTimelineTypography(element: Element, revision: number): TimelineTypography {
  const style = getComputedStyle(element)
  const size = parseFloat(style.getPropertyValue("--font-size-base"))
  const leading = style.getPropertyValue("--line-height-large").trim()
  // Resolve CSS chrome once with typography. Browsers snap a .5px border differently;
  // this empty style probe reads no content geometry and never measures a timeline row.
  const probe = document.createElement("div")
  probe.dataset.component = "markdown"
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none"
  const code = document.createElement("pre")
  code.className = "shiki"
  probe.append(code)
  element.append(probe)
  const chrome = getComputedStyle(code)
  const codeInset = [chrome.paddingTop, chrome.paddingBottom, chrome.borderTopWidth, chrome.borderBottomWidth].reduce(
    (sum, value) => sum + parseFloat(value),
    0,
  )
  probe.remove()
  return {
    family: style.getPropertyValue("--font-family-sans").trim(),
    codeFamily: style.getPropertyValue("--font-family-mono").trim(),
    codeInset,
    rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
    size,
    weight: parseFloat(style.getPropertyValue("--font-weight-regular")),
    medium: parseFloat(style.getPropertyValue("--font-weight-medium")),
    bold: parseFloat(style.getPropertyValue("--font-weight-bold")),
    lineHeight: leading.endsWith("%") ? (size * parseFloat(leading)) / 100 : parseFloat(leading),
    letterSpacing: parseFloat(style.getPropertyValue("--letter-spacing-normal")) || 0,
    revision,
  }
}

/** The cache belongs to a session renderer. Width is deliberately absent from preparation keys. */
export function createTimelineTextLayout() {
  const text = new Map<string, { signature: string; prepared: PreparedText }>()
  const rich = new Map<string, { signature: string; prepared: ReturnType<typeof prepareRichInline> }>()
  let revision = -1

  function refresh(next: number) {
    if (next === revision) return
    revision = next
    clearCache()
    text.clear()
    rich.clear()
  }

  return {
    text(key: string, value: string, width: number, style: TimelineTypography, whiteSpace: "normal" | "pre-wrap") {
      refresh(style.revision)
      const font = `${style.weight} ${style.size}px ${style.family}`
      const signature = JSON.stringify([value, font, style.letterSpacing, whiteSpace])
      const previous = text.get(key)
      const prepared =
        previous?.signature === signature
          ? previous.prepared
          : prepare(value, font, { whiteSpace, letterSpacing: style.letterSpacing })
      if (previous?.prepared !== prepared) text.set(key, { signature, prepared })
      return layout(prepared, Math.max(1, width), style.lineHeight).height
    },
    rich(key: string, items: RichInlineItem[], width: number, lineHeight: number, revision: number) {
      refresh(revision)
      const signature = JSON.stringify(items)
      const previous = rich.get(key)
      const prepared = previous?.signature === signature ? previous.prepared : prepareRichInline(items)
      if (previous?.prepared !== prepared) rich.set(key, { signature, prepared })
      return measureRichInlineStats(prepared, Math.max(1, width)).lineCount * lineHeight
    },
    ch(style: TimelineTypography) {
      refresh(style.revision)
      const font = `${style.weight} ${style.size}px ${style.family}`
      const key = `ch:${font}`
      const previous = text.get(key)
      if (previous) return measureNaturalWidth(previous.prepared)
      const prepared = prepare("0", font)
      text.set(key, { signature: font, prepared })
      return measureNaturalWidth(prepared)
    },
  }
}
