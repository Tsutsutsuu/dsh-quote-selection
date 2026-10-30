/**
 * Browser half of the Quote Selection bundle.
 *
 * Three registrations, no host round-trips:
 *
 * 1. `shell.overlay` — a right-click menu for a non-collapsed text selection
 *    inside a chat message row. It reads the selection, derives where it came
 *    from (message author, turn, paragraph, character range) and formats one
 *    quote block.
 * 2. `conversation.composer.dock` — an invisible bridge that owns the composer
 *    for the active Session. It inserts the quote as an atomic reference chip
 *    (`insertReference`) whose visible label is short while its clipboard and
 *    prompt projection is the full block, so the draft keeps one editable pill
 *    instead of a wall of text.
 * 3. `conversation.user.text.node` — a renderer for the sent quote blocks, so a
 *    message shows a compact quote card that expands to the quoted text.
 *
 * The quote body still travels as ordinary user-message text, so the block and
 * its location are durable session log content and the model reads them
 * verbatim; only the two surfaces (draft, transcript) fold them.
 *
 * Location data comes from the Chat flow row the selection lives in: rows carry
 * `data-chat-flow-key`, `data-chat-flow-kind` and `data-chat-turn` (see
 * ui-chat's ChatView flow item). Paragraph index and character range are read
 * from the DOM around the selection, so they stay correct without any
 * conversation state subscription.
 */

window.__ModuleLoader__.load({
  id: 'dsh-quote-selection',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const NS = 'quote-selection'
    const MENU_ID = 'quote-selection-menu'
    const BRIDGE_ID = 'quote-selection-bridge'
    /** UserText rule id, i.e. the `conversation.user.text.node` dispatch key. */
    const RULE_ID = 'quote'
    /** Reference-chip source name owned by this plugin. */
    const CHIP_SOURCE = 'quote-selection'

    /** Hard cap so one quote can never flood the composer or the request. */
    const MAX_QUOTE_CHARS = 4000
    /** How far outside a selected glyph a right-click still counts as "on it". */
    const CLICK_SLOP_PX = 6
    /** Menu box estimate (two rows), used to clamp it inside the viewport. */
    const MENU_WIDTH = 160
    const MENU_HEIGHT = 76
    /** A quote nobody consumed within this window is stale (no composer was open). */
    const PENDING_TTL_MS = 30000

    /**
     * Message containers, newest match first: the official Chat flow row, then
     * (best effort) the reading view's node anchor and turn section.
     */
    const ROW_SELECTOR = '[data-chat-flow-key], [data-reader-anchor], [data-reader-turn]'
    /** Opening and closing markers of the wire quote block. */
    const QUOTE_OPEN = '【引用 · '
    const QUOTE_CLOSE = '【/引用】'
    /** Default preview lengths; the settings page overrides both. */
    const CHIP_PREVIEW_CHARS = 12
    const CARD_PREVIEW_CHARS = 40
    /** Local preference storage for the settings page. */
    const SETTINGS_KEY = 'dsh-quote-selection/settings-v1'
    const SETTINGS_DEFAULT = Object.freeze({
      chipPreview: CHIP_PREVIEW_CHARS,
      cardPreview: CARD_PREVIEW_CHARS,
    })
    /** Preview length bounds, shared by sanitizing and the number inputs. */
    const PREVIEW_MIN = 4
    const PREVIEW_MAX = 80
    /** Chat node kind to the human-readable author/source label. */
    const ROLE_LABELS = {
      user: '用户消息',
      steering: '用户插话',
      'assistant-step': '助手消息',
      'tool-call': '工具调用',
      'turn-process': '过程',
      compaction: '上下文压缩',
      'manual-compaction': '手动压缩',
      command: '命令',
      'command-input': '命令输入',
      'question-reply': '用户回答',
      'system-prompt': '系统提示',
      'turn-trigger': '系统',
      'turn-error': '错误',
      'turn-max-tokens': '长度上限',
      context: '上下文',
      'workflow-run': '工作流',
      unknown: '其他',
    }
    /** Elements that count as one block of message copy (paragraph, item, line). */
    const BLOCK_TAGS = new Set([
      'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE',
      'TD', 'TH', 'DT', 'DD', 'TR', 'FIGCAPTION',
    ])

    /** UI chrome copy; the wire quote block itself is locale-independent. */
    const EN = {
      'menu.quote': 'Quote',
      'menu.copy': 'Copy',
      'card.expand': 'expand',
      'card.collapse': 'collapse',
      'card.chars': '{n} chars',
      'toast.copied': 'Copied',
      'toast.copyFailed': 'Could not write to the clipboard',
      'toast.busy': 'The composer is not editable right now — the quote was copied instead',
      'settings.title': 'Quote selection',
      'settings.chip.title': 'Composer chip preview',
      'settings.chip.desc': 'How many characters of the quoted text the composer tag shows.',
      'settings.card.title': 'Message card preview',
      'settings.card.desc': 'How many characters the folded quote in a message shows.',
      'settings.range': '{min}–{max} characters',
      'settings.descWithRange': '{desc} ({range})',
      'settings.shortcut.title': 'Quote shortcut',
      'settings.shortcut.desc':
        'Select transcript text and press Ctrl+Q to quote it directly (Ctrl+Shift+Q also works; on macOS use ⌘⇧Q).',
    }
    const ZH = {
      'menu.quote': '引用',
      'menu.copy': '复制',
      'card.expand': '展开',
      'card.collapse': '收起',
      'card.chars': '{n} 字',
      'toast.copied': '已复制',
      'toast.copyFailed': '复制失败',
      'toast.busy': '输入框当前不可编辑，引用已复制到剪贴板',
      'settings.title': '选区引用',
      'settings.chip.title': '草稿标签预览字数',
      'settings.chip.desc': '输入框里的引用标签显示引用内容的字符数。',
      'settings.card.title': '消息卡片预览字数',
      'settings.card.desc': '消息里折叠的引用卡显示引用内容的字符数。',
      'settings.range': '{min}–{max} 字',
      'settings.descWithRange': '{desc}（{range}）',
      'settings.shortcut.title': '引用快捷键',
      'settings.shortcut.desc': '选中对话文字后按 Ctrl+Q 直接引用（Ctrl+Shift+Q 也可；macOS 用 ⌘⇧Q）。',
    }

    // ---------------------------------------------------------------- helpers

    /**
     * The element for one selection endpoint.
     * @param {Node} node - selection endpoint.
     * @returns {Element | null} element, when the node can be searched from.
     */
    function elementOf(node) {
      if (!node) return null
      const element = node.nodeType === 1 ? node : node.parentElement
      return element && typeof element.closest === 'function' ? element : null
    }

    /**
     * The container that holds one message, in either transcript surface:
     * the official Chat flow row, or (best effort) the reading view's anchor.
     * @param {Node} node - selection endpoint.
     * @returns {Element | null} the row wrapper.
     */
    function rowOf(node) {
      const element = elementOf(node)
      return element ? element.closest(ROW_SELECTOR) : null
    }

    /**
     * Best-effort Chat node kind inside the reading view (dsh-better-display).
     *
     * That view keeps a handful of stable `data-reader-*` anchors and reuses the
     * official `data-chat-flow-kind` attribute on nodes it passes through. A
     * view without them simply yields an empty kind, and the quote still works
     * with a generic label.
     * @param {Element} element - selection start element.
     * @returns {string} Chat node kind, or '' when unknown.
     */
    function readerKindOf(element) {
      const kinded = element.closest('[data-chat-flow-kind]')
      if (kinded) return kinded.getAttribute('data-chat-flow-kind') || ''
      if (element.closest('[data-reader-answer]')) return 'assistant-step'
      if (element.closest('[data-reader-reasoning-card]')) return 'assistant-step'
      if (element.closest('[data-reader-tool-call]')) return 'tool-call'
      if (element.closest('[data-reader-compaction]')) return 'compaction'
      // The reading view renders the user's message as the turn's first anchor.
      const turn = element.closest('[data-reader-turn]')
      const anchor = element.closest('[data-reader-anchor]')
      if (
        turn &&
        anchor &&
        typeof turn.querySelector === 'function' &&
        turn.querySelector('[data-reader-anchor]') === anchor
      ) {
        return 'user'
      }
      return ''
    }

    /**
     * Locate the message a selection belongs to, with the source facts the wire
     * block needs.
     * @param {Node} node - selection endpoint.
     * @returns {{ row: Element, kind: string, turn: string, degraded: boolean } | null}
     */
    function describeRow(node) {
      const element = elementOf(node)
      if (!element) return null
      const row = element.closest(ROW_SELECTOR)
      if (!row) {
        // Last resort: any transcript scroller. The quote still works, the
        // location degrades to a generic label, so a reading view that renames
        // its own markers does not disable quoting.
        const scroller = element.closest('[data-conversation-scroll]')
        return scroller ? { row: scroller, kind: '', turn: '', degraded: true } : null
      }
      if (row.getAttribute('data-chat-flow-key') !== null) {
        return {
          row,
          kind: row.getAttribute('data-chat-flow-kind') || '',
          turn: row.getAttribute('data-chat-turn') || '',
          degraded: false,
        }
      }
      const turnElement = element.closest('[data-reader-turn]')
      const turn = turnElement ? turnElement.getAttribute('data-reader-turn') || '' : ''
      return {
        row,
        kind: readerKindOf(element),
        turn: turn === 'unresolved' ? '' : turn,
        degraded: false,
      }
    }

    /**
     * The outermost block element (paragraph, list item, code block …) between
     * a node and its flow row. Outermost is what a reader calls "that block".
     * @param {Node} node - selection start.
     * @param {Element} row - enclosing flow row.
     * @returns {Element | null} the block, when the selection sits in one.
     */
    function outermostBlock(node, row) {
      let element = node && node.nodeType === 1 ? node : node && node.parentElement
      let found = null
      while (element && element !== row) {
        if (element.tagName && BLOCK_TAGS.has(element.tagName)) found = element
        element = element.parentElement
      }
      return found
    }

    /**
     * Index of one block among its block siblings.
     * @param {Element} block - the block element.
     * @returns {{ index: number, total: number } | null} 1-based position.
     */
    function blockIndex(block) {
      const parent = block.parentElement
      if (!parent) return null
      const siblings = Array.from(parent.children).filter(
        (child) => child.tagName && BLOCK_TAGS.has(child.tagName),
      )
      const index = siblings.indexOf(block)
      if (index < 0 || siblings.length < 2) return null
      return { index: index + 1, total: siblings.length }
    }

    /**
     * Character range of a selection inside one container, counted in the
     * container's rendered text.
     * @param {Element} container - block element or flow row.
     * @param {Range} range - the live selection range.
     * @returns {{ start: number, end: number } | null} offsets in characters.
     */
    function offsetsWithin(container, range) {
      try {
        const head = document.createRange()
        head.selectNodeContents(container)
        if (container.contains(range.startContainer)) {
          head.setEnd(range.startContainer, range.startOffset)
        } else {
          return null
        }
        const start = head.toString().length

        const tail = document.createRange()
        tail.selectNodeContents(container)
        if (container.contains(range.endContainer)) {
          tail.setEnd(range.endContainer, range.endOffset)
        }
        const end = tail.toString().length
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
        return { start, end }
      } catch (error) {
        console.warn('[quote-selection] could not measure the selection', error)
        return null
      }
    }

    /**
     * Describe where a selection came from.
     *
     * A degraded location (no message container was found, only the transcript
     * scroller) reports the author alone: block indexes and character offsets
     * measured against the whole transcript would be misleading.
     * @param {Range} range - the live selection range.
     * @returns {{ role: string, parts: string[] } | null} location copy.
     */
    function describeSelection(range) {
      const start = describeRow(range.startContainer)
      if (!start) return null

      const role = ROLE_LABELS[start.kind] || '消息'
      const parts = [role]
      if (start.turn) parts.push('第' + start.turn + '轮')
      if (start.degraded) return { role, parts }

      const end = describeRow(range.endContainer)
      const block = outermostBlock(range.startContainer, start.row)
      const index = block ? blockIndex(block) : null
      const offsets = block ? offsetsWithin(block, range) : offsetsWithin(start.row, range)
      if (index) parts.push('第' + index.index + '/' + index.total + '段')
      if (offsets) {
        const scope = block ? '' : '消息内'
        parts.push(scope + '字符' + offsets.start + '–' + offsets.end)
      }
      if (end && end.row !== start.row) parts.push('选区跨多条消息')

      return { role, parts }
    }

    /**
     * Trim a selection to a tidy block body.
     * @param {string} input - selected text.
     * @returns {{ text: string, truncated: boolean }} normalized text.
     */
    function normalizeQuoteText(input) {
      let text = String(input).replace(/\r\n?/g, '\n')
      text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
      if (text.length <= MAX_QUOTE_CHARS) return { text, truncated: false }
      return { text: text.slice(0, MAX_QUOTE_CHARS), truncated: true }
    }

    /**
     * Build the wire quote block that enters the draft and the prompt.
     * @param {{ parts: string[] }} description - location copy.
     * @param {string} text - normalized quote body.
     * @param {boolean} truncated - whether the body was cut at the cap.
     * @returns {string} wire text, ending with one newline after the closing marker.
     */
    function formatQuote(description, text, truncated) {
      const head = QUOTE_OPEN + description.parts.join(' · ') + '】'
      const body = truncated ? text + '\n……（引用已截断，共 ' + MAX_QUOTE_CHARS + ' 字符）' : text
      return head + '\n' + body + '\n' + QUOTE_CLOSE + '\n'
    }

    /**
     * Flatten one quote body into a single-line preview.
     *
     * The visible surfaces lead with the quoted content (that is what the user
     * needs to recognize) and keep only the author label beside it; the exact
     * location stays in the wire block and in the hover title.
     * @param {unknown} body - quoted text.
     * @param {number} max - characters kept before the ellipsis.
     * @returns {string} one-line preview.
     */
    function quotePreview(body, max) {
      const flat = String(body == null ? '' : body).replace(/\s+/gu, ' ').trim()
      return flat.length <= max ? flat : flat.slice(0, max) + '…'
    }

    /**
     * The label the draft chip shows for one quote.
     *
     * Content first (what the user recognizes), then the count, then the author
     * as a trailing tag. The chip's visible text is one text node rendered by
     * the host, so the count cannot be set in a smaller type size here (the
     * in-message card does use small type).
     * @param {{ role?: string }} description - location copy.
     * @param {string} body - normalized quote body.
     * @param {number} [previewChars] - preview length (settings page override).
     * @returns {string} chip label, e.g. `它把 location 写进…   42 字 · 助手消息`.
     */
    function formatQuoteChipLabel(description, body, previewChars) {
      const role = description && description.role ? description.role : '消息'
      const count = String(body == null ? '' : body).length
      const max = Number.isFinite(previewChars) ? previewChars : CHIP_PREVIEW_CHARS
      return quotePreview(body, max) + '   ' + count + ' 字 · ' + role
    }

    /**
     * Submit-time serialization of one quote chip.
     *
     * A current chip stores the complete wire block as its reference id, so its
     * model form is that id. A chip minted by an older build (or by some other
     * writer) carries no text; that case yields an empty string so the draft
     * still sends, and the console records the loss.
     * @param {unknown} ref - the chip's reference id.
     * @returns {string} text spliced into the prompt.
     */
    function stripStaleQuote(ref) {
      if (typeof ref === 'string' && ref.indexOf(QUOTE_OPEN) >= 0) return ref
      console.warn('[quote-selection] stale quote chip without stored text; dropped from the prompt')
      return ''
    }

    /**
     * Match the next quote block in sent message text.
     *
     * Returns a plain business node for the UserText evaluator: the whole block
     * becomes one node, so the transcript can fold it. A malformed or unclosed
     * marker yields no match, and the original text stays visible.
     * @param {string} text - original message text.
     * @param {number} from - offset to start searching at.
     * @returns {{ id: string, start: number, end: number, data: object } | undefined}
     */
    function matchQuoteBlock(text, from) {
      if (typeof text !== 'string') return undefined
      const start = text.indexOf(QUOTE_OPEN, from)
      if (start < 0) return undefined
      const headEnd = text.indexOf('】', start + QUOTE_OPEN.length)
      if (headEnd < 0) return undefined
      const closeStart = text.indexOf(QUOTE_CLOSE, headEnd + 1)
      if (closeStart < 0) return undefined
      const location = text.slice(start + QUOTE_OPEN.length, headEnd).trim()
      const body = text.slice(headEnd + 1, closeStart).replace(/^\n/, '').replace(/\n$/, '')
      if (location === '') return undefined
      return {
        id: RULE_ID,
        start,
        end: closeStart + QUOTE_CLOSE.length,
        data: { role: location.split(' · ')[0] || '消息', location, body },
      }
    }

    /**
     * Split one text block into literal text runs and quote cards.
     *
     * The reading view renders user text as plain blocks instead of the official
     * UserText nodes, and its block chain can only swap a whole block. A block
     * that contains at least one quote is therefore claimed as a whole and
     * re-rendered as runs: the typed words stay plain text, every quote becomes
     * a card. Blocks without a quote are left to the reading view.
     * @param {string} text - block text.
     * @returns {Array<{ kind: 'text', text: string } | { kind: 'quote', data: object }> | null}
     *   segments, or null when the block has no quote.
     */
    function splitQuoteSegments(text) {
      if (typeof text !== 'string' || text === '') return null
      const segments = []
      let cursor = 0
      let found = false
      for (;;) {
        const match = matchQuoteBlock(text, cursor)
        if (!match) break
        if (match.start > cursor) segments.push({ kind: 'text', text: text.slice(cursor, match.start) })
        segments.push({ kind: 'quote', data: match.data })
        cursor = match.end
        found = true
      }
      if (!found) return null
      if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) })
      return segments.filter(
        (segment) => segment.kind !== 'text' || segment.text.trim() !== '',
      )
    }

    /**
     * Whether a right-click landed on the selected glyphs themselves.
     * @param {MouseEvent} event - the contextmenu event.
     * @param {Range} range - the live selection range.
     * @returns {boolean} true when the pointer is within the selection.
     */
    function clickInsideRange(event, range) {
      let rects
      try {
        rects = range.getClientRects()
      } catch {
        return false
      }
      for (let i = 0; i < rects.length; i += 1) {
        const rect = rects[i]
        if (rect.width === 0 && rect.height === 0) continue
        if (
          event.clientX >= rect.left - CLICK_SLOP_PX &&
          event.clientX <= rect.right + CLICK_SLOP_PX &&
          event.clientY >= rect.top - CLICK_SLOP_PX &&
          event.clientY <= rect.bottom + CLICK_SLOP_PX
        ) {
          return true
        }
      }
      return false
    }

    /**
     * Whether this page runs on macOS, for shortcut display and for refusing
     * ⌘Q (which quits the application).
     * @param {Navigator} [nav] - navigator stand-in, injectable for tests.
     * @returns {boolean} true on macOS.
     */
    function isMacPlatform(nav) {
      try {
        const source = nav || (typeof navigator === 'undefined' ? undefined : navigator)
        if (!source) return false
        const platform = String(source.platform || '')
        const agent = String(source.userAgent || '')
        return /mac/i.test(platform) || /Mac OS X/i.test(agent)
      } catch {
        return false
      }
    }

    /**
     * Whether one keydown is the quote shortcut: Ctrl/Cmd + Q, with or without
     * Shift (Shift stays available as a fallback for environments that bind
     * plain Ctrl+Q, e.g. Chromium on Linux exits with it). On macOS the plain
     * ⌘Q variant is refused because the system quits with it.
     *
     * Matched on the physical `code`, so keyboard layouts and the Shift-cased
     * `key` value cannot change it.
     * @param {KeyboardEvent} event - the keydown event.
     * @param {boolean} [mac] - whether the platform is macOS.
     * @returns {boolean} true for the quote shortcut.
     */
    function isQuoteShortcut(event, mac = isMacPlatform()) {
      if (!event || event.code !== 'KeyQ') return false
      if (!(event.ctrlKey || event.metaKey)) return false
      if (event.altKey) return false
      if (mac && event.metaKey && !event.shiftKey) return false
      return true
    }

    /**
     * Display label of the quote shortcut on this platform.
     * @param {boolean} [mac] - whether the platform is macOS.
     * @returns {string} shortcut label.
     */
    function quoteShortcutLabel(mac = isMacPlatform()) {
      return mac ? '⌘⇧Q' : 'Ctrl+Q'
    }

    /**
     * Display label of the copy shortcut on this platform.
     * @param {boolean} [mac] - whether the platform is macOS.
     * @returns {string} shortcut label.
     */
    function copyShortcutLabel(mac = isMacPlatform()) {
      return mac ? '⌘C' : 'Ctrl+C'
    }

    /**
     * Read the current selection when it lies inside a chat message.
     * @returns {{ text: string, range: Range, description: { role: string, parts: string[] } } | null}
     */
    function readSelection() {
      const selection = window.getSelection()
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
      const range = selection.getRangeAt(0)
      const text = selection.toString()
      if (!text || text.trim() === '') return null
      const description = describeSelection(range)
      if (!description) return null
      return { text, range: range.cloneRange(), description }
    }

    /**
     * Copy text through the async clipboard API.
     * @param {string} text - text to copy.
     * @returns {Promise<boolean>} whether the write succeeded.
     */
    async function copyText(text) {
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch (error) {
        console.warn('[quote-selection] clipboard write failed', error)
      }
      return false
    }

    // ------------------------------------------------------------------- bus

    /**
     * A module-local hand-off between the overlay menu and the composer bridge.
     * Plain callbacks only: no state, no subscription leaks.
     */
    function createBus() {
      const queue = []
      const insertListeners = new Set()
      const noticeListeners = new Set()

      return {
        enqueue(item) {
          queue.push({ ...item, at: Date.now() })
          for (const listener of Array.from(insertListeners)) {
            try {
              listener()
            } catch (error) {
              console.warn('[quote-selection] insert listener failed', error)
            }
          }
        },
        drain() {
          const now = Date.now()
          const live = queue.filter((item) => now - item.at <= PENDING_TTL_MS)
          queue.length = 0
          return live
        },
        pending() {
          return queue.length
        },
        onInsert(listener) {
          insertListeners.add(listener)
          return () => insertListeners.delete(listener)
        },
        notice(text) {
          for (const listener of Array.from(noticeListeners)) {
            try {
              listener(text)
            } catch (error) {
              console.warn('[quote-selection] notice listener failed', error)
            }
          }
        },
        onNotice(listener) {
          noticeListeners.add(listener)
          return () => noticeListeners.delete(listener)
        },
      }
    }

    // -------------------------------------------------------------- settings

    /** Clamp one numeric preference into its allowed range. */
    function clampInt(value, min, max, fallback) {
      const number = Number(value)
      if (!Number.isFinite(number)) return fallback
      return Math.min(max, Math.max(min, Math.round(number)))
    }

    /** Normalize any stored/partial settings object. */
    function sanitizeSettings(input) {
      const source = input && typeof input === 'object' ? input : {}
      return {
        chipPreview: clampInt(source.chipPreview, PREVIEW_MIN, PREVIEW_MAX, SETTINGS_DEFAULT.chipPreview),
        cardPreview: clampInt(source.cardPreview, PREVIEW_MIN, PREVIEW_MAX, SETTINGS_DEFAULT.cardPreview),
      }
    }

    /**
     * The plugin's own preferences, stored as one JSON value in localStorage.
     *
     * These are client-only display preferences (preview lengths), so they need
     * no Host round-trip; a failed write degrades to
     * in-memory values for the rest of the page session.
     */
    function createSettings() {
      let state = null
      const listeners = new Set()
      const notify = () => {
        for (const listener of Array.from(listeners)) {
          try {
            listener()
          } catch (error) {
            console.warn('[quote-selection] settings listener failed', error)
          }
        }
      }
      const load = () => {
        try {
          const raw = window.localStorage.getItem(SETTINGS_KEY)
          if (typeof raw === 'string' && raw !== '') return sanitizeSettings(JSON.parse(raw))
        } catch (error) {
          console.warn('[quote-selection] could not read settings', error)
        }
        return { ...SETTINGS_DEFAULT }
      }
      return {
        get() {
          if (state === null) state = load()
          return state
        },
        update(patch) {
          state = sanitizeSettings({ ...this.get(), ...patch })
          try {
            window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(state))
          } catch (error) {
            console.warn('[quote-selection] could not persist settings', error)
          }
          notify()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    /**
     * Subscribe one component to the settings snapshot.
     * @param {ReturnType<typeof createSettings>} store - settings store.
     * @returns {object} current settings.
     */
    function useSettingsSnapshot(store) {
      const [snapshot, setSnapshot] = useState(() => store.get())
      useEffect(() => store.subscribe(() => setSnapshot(store.get())), [store])
      return snapshot
    }

    // ---------------------------------------------------------------- styles

    /**
     * Class names of the transcript quote surfaces. Hover styling lives in CSS
     * (not React state): expanding replaces the chip with the card header, and a
     * replaced node never receives `pointerleave`, which would leave a JS hover
     * flag stuck on.
     */
    const CLS_CHIP = 'qs-quote-chip'
    const CLS_CARD = 'qs-quote-card'
    const CLS_HEADER = 'qs-quote-header'
    const CLS_BODY = 'qs-quote-body'
    const CLS_MARK = 'qs-quote-mark'
    const CLS_LABEL = 'qs-quote-label'
    const CLS_ROLE = 'qs-quote-role'
    const CLS_META = 'qs-quote-meta'
    const CLS_ARROW = 'qs-quote-arrow'
    /** Marker attribute on the injected stylesheet, so HMR replaces one tag. */
    const STYLE_TAG = 'dsh-quote-selection/quote-card.css'
    /**
     * The host renders a composer chip as two nested spans:
     * `<span data-composer-chip="<source>"><span class=chip>
     *   <glyph/><label/></span></span>`.
     * `CHIP_SEL` is the outer Lexical host span; `CHIP_INNER` is the React chip
     * element that carries the inline-flex layout, so width, background, and
     * glyph hiding must target the inner one (an inline outer span ignores
     * `max-width`, and hiding its only child blanks the whole chip).
     */
    const CHIP_SEL = 'span[data-composer-chip="' + CHIP_SOURCE + '"]'
    const CHIP_INNER = CHIP_SEL + ' > span'
    /** Every color is a host theme token, so light/dark switching costs nothing. */
    const QUOTE_CSS = [
      '.qs-quote-chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;',
      'padding:0 6px;margin:0 1px;border:0.5px solid transparent;border-radius:6px;',
      'background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;',
      'font-size:13px;line-height:22px;text-align:left;vertical-align:baseline;cursor:default}',
      '.qs-quote-chip[data-interactive="true"]{cursor:pointer}',
      '.qs-quote-chip[data-interactive="true"]:hover{border-color:var(--dsw-alias-border-l1);',
      'background:var(--dsw-alias-bg-layer-2)}',
      '.qs-quote-card{display:block;max-width:100%;margin:6px 0 2px;overflow:hidden;',
      'border:0.5px solid var(--dsw-alias-border-l1);border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-1);text-align:left}',
      '.qs-quote-header{display:flex;align-items:center;gap:6px;width:100%;',
      'padding:6px 10px;border:0;border-bottom:0.5px solid var(--dsw-alias-border-l1);',
      'border-radius:0;background:transparent;color:var(--dsw-alias-label-secondary);',
      'font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:default}',
      '.qs-quote-header[data-interactive="true"]{cursor:pointer}',
      '.qs-quote-header[data-interactive="true"]:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.qs-quote-header .qs-quote-label{flex:1 1 auto}',
      '.qs-quote-body{display:block;padding:8px 12px 10px;',
      'color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;',
      'line-height:21px;white-space:pre-wrap;overflow-wrap:anywhere;',
      'max-height:320px;overflow:auto}',
      // Summary hierarchy: content at body size/weight; the count and the
      // trailing author tag use small emphatic type.
      '.qs-quote-mark{flex:none;font-weight:400;',
      'color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary))}',
      '.qs-quote-label{flex:0 1 auto;min-width:0;overflow:hidden;',
      'text-overflow:ellipsis;white-space:nowrap;font-weight:400}',
      '.qs-quote-meta{flex:none;font-size:11px;line-height:16px;font-weight:600;',
      'color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}',
      '.qs-quote-role{flex:none;font-size:11px;line-height:16px;font-weight:600;',
      'white-space:nowrap;',
      'color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}',
      '.qs-quote-arrow{flex:none;font-size:10px;line-height:16px;',
      'color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}',
      // Draft chip (host-rendered): a quiet quote tag instead of the default
      // "@"-style mention. The host caps the chip at 240px and shows a session
      // glyph; both fight a sentence-long location label. Styles go on the
      // inner React chip element, never on the outer Lexical host span.
      // Fixed colors are intentional (user-chosen); the chip is not clickable,
      // so there is no hover state. The draft chip's text is one node rendered
      // by the host, so it cannot mix weights: it stays at body weight.
      CHIP_INNER + '{max-width:min(100%,520px);padding:0 7px;border-radius:6px;',
      'align-items:center;background:#ECF1FC;color:#4176E6;cursor:default;',
      'font-weight:400;',
      '-webkit-box-decoration-break:clone;box-decoration-break:clone}',
      // The host's own chip rule paints a hover background; pin both states to
      // the same colors because the chip has no click action.
      CHIP_INNER + ':hover{background:#ECF1FC;color:#4176E6}',
      // Dark theme: the host marks it with `body[data-ds-dark-theme]`, the same
      // hook its own token layer uses. Text and glyph lighten for contrast on
      // the darker fill.
      'body[data-ds-dark-theme] ' + CHIP_INNER + '{background:#343943;color:#7AAAFF}',
      'body[data-ds-dark-theme] ' + CHIP_INNER + ':hover{background:#343943;color:#7AAAFF}',
      'body[data-ds-dark-theme] ' + CHIP_INNER + '::before{color:#7AAAFF}',
      // Selection menu: a white surface with fixed dark text, as requested, so
      // it reads the same in light and dark themes.
      '.qs-menu{position:fixed;z-index:2147483000;padding:4px;border-radius:12px;',
      'border:0.5px solid rgba(0,0,0,0.08);background:#ffffff;color:#1f2329;',
      'box-shadow:0 10px 28px rgba(0,0,0,0.18);font:inherit;font-size:13px;',
      'line-height:20px;pointer-events:auto;user-select:none}',
      '.qs-menu-item{display:flex;align-items:center;justify-content:space-between;',
      'gap:20px;width:100%;padding:7px 12px;border:0;',
      'border-radius:8px;background:transparent;color:inherit;font:inherit;',
      'text-align:left;cursor:pointer;white-space:nowrap}',
      '.qs-menu-item:hover{background:rgba(0,0,0,0.05)}',
      '.qs-menu-item-label{flex:none}',
      '.qs-menu-item-hint{flex:none;font-size:12px;line-height:20px;',
      'color:rgba(0,0,0,0.45)}',
      // Settings page rows: same rhythm as the shipped settings pages.
      '.qs-settings{max-width:760px;padding-top:20px;display:flex;flex-direction:column}',
      '.qs-setting{display:flex;align-items:center;gap:8px}',
      '.qs-setting+.qs-setting{margin-top:28px}',
      '.qs-setting-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;padding-right:48px}',
      '.qs-setting-title{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}',
      '.qs-setting-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.qs-number{width:72px;height:32px;border-radius:8px;',
      'border:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);',
      'color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:0 8px;',
      'text-align:right}',
      // Hide the host glyph (a session bubble) but never the last child: the
      // label is always last, so a structure change cannot blank the chip.
      CHIP_INNER + ' > :not(:last-child){display:none}',
      // `pre` keeps the run of spaces between the preview and the count (the
      // host label is `nowrap`, which would collapse them to one).
      CHIP_INNER + ' > :last-child{white-space:pre}',
      CHIP_INNER + '::before{content:"❝";font-weight:400;flex:none;color:#4176E6}',
    ].join('')

    /**
     * Install the quote-card stylesheet for this plugin's lifetime.
     * @returns {() => void} removal of the tag.
     */
    function installQuoteStyles() {
      if (typeof document === 'undefined') return () => {}
      // Replace any tag from an earlier module generation first: plugin reload
      // disposes effects in an implementation-defined order, and a stale
      // stylesheet must never outlive the current one.
      const selector = 'style[data-plugin-css=' + JSON.stringify(STYLE_TAG) + ']'
      for (const previous of Array.from(document.querySelectorAll(selector))) previous.remove()
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-quote-selection'
      tag.dataset.pluginCss = STYLE_TAG
      tag.textContent = QUOTE_CSS
      document.head.appendChild(tag)
      return () => {
        tag.remove()
      }
    }

    return {
      inject: ['slots', 'locale', 'uiConversation', 'inputTriggers'],

      apply(ctx) {
        const bus = createBus()
        const settings = createSettings()
        const t = ctx.locale.bind(NS)

        // Stylesheet first: the transcript renderer may mount before any other
        // registration settles.
        ctx.effect(installQuoteStyles, 'quote-selection: quote card styles')

        ctx.effect(
          () => ctx.locale.register(NS, 'en', EN),
          'quote-selection: English copy',
        )
        ctx.effect(
          () => ctx.locale.register(NS, 'zh', ZH),
          'quote-selection: Chinese copy',
        )

        /**
         * Turn one selection into a queued composer insertion.
         *
         * Shared by the context menu, the keyboard shortcut, and any future
         * entry point, so all of them apply the same normalization and the same
         * preview setting.
         * @param {string} text - selected text.
         * @param {{ role: string, parts: string[] }} description - location copy.
         * @returns {boolean} whether anything was queued.
         */
        function commitQuote(text, description) {
          const normalized = normalizeQuoteText(text)
          if (normalized.text === '') return false
          bus.enqueue({
            wireText: formatQuote(description, normalized.text, normalized.truncated),
            chipLabel: formatQuoteChipLabel(
              description,
              normalized.text,
              settings.get().chipPreview,
            ),
          })
          return true
        }

        /**
         * Push one quote into the composer as an atomic chip.
         *
         * The chip keeps the draft readable (one pill), while its text
         * projection — what the draft persists, copies, and submits — is the
         * full wire block. Without a reachable composer shell, the same text is
         * inserted as plain text so the feature still works.
         * @param {{ wireText: string, chipLabel: string }} quote - the quote to insert.
         * @param {object | null} actions - composer InputActions face.
         * @param {string | undefined} sessionId - composer Session.
         * @returns {boolean} whether the draft accepted the insertion.
         */
        function insertQuote(quote, actions, sessionId) {
          if (!actions || typeof actions.captureInsertion !== 'function') return false
          try {
            const span = actions.captureInsertion()
            const controller = ctx.get('conversation')
            const hub = controller && controller.input
            if (hub && typeof hub.shell === 'function' && sessionId !== undefined) {
              let shell = null
              try {
                shell = hub.shell(sessionId)
              } catch (error) {
                console.warn('[quote-selection] no composer shell for this session', error)
              }
              if (shell && typeof shell.insertReference === 'function') {
                const reference = {
                  source: CHIP_SOURCE,
                  // The reference id carries the complete wire block: the submit
                  // path serializes a chip through its source codec, which only
                  // receives this id. Keeping the block here makes the chip
                  // self-contained, so a persisted or restored draft still
                  // serializes correctly.
                  ref: quote.wireText,
                  label: quote.chipLabel,
                  // The session glyph is the closest shipped chip face for
                  // "a passage that came from this conversation".
                  appearance: 'session',
                  clipboardText: quote.wireText,
                }
                if (shell.insertReference(reference, span) === true) return true
              }
            }
            if (typeof actions.insertText !== 'function') return false
            return actions.insertText(quote.wireText, span) === true
          } catch (error) {
            console.warn('[quote-selection] composer insert failed', error)
            return false
          }
        }

        // ------------------------------------------------------ menu button

        /**
         * One row of the selection menu. Hover styling is CSS (`.qs-menu-item`),
         * so this stays a plain stateless button.
         * @param {{ label: string, hint?: string, onSelect: () => void }} props - row copy, shortcut hint, and action.
         */
        function MenuItem({ label, hint, onSelect }) {
          return h(
            'button',
            {
              type: 'button',
              role: 'menuitem',
              className: 'qs-menu-item',
              onClick: onSelect,
            },
            h('span', { className: 'qs-menu-item-label' }, label),
            hint === undefined || hint === ''
              ? null
              : h('span', { className: 'qs-menu-item-hint' }, hint),
          )
        }

        // ------------------------------------------------------------ menu

        function QuoteMenu() {
          const [menu, setMenu] = useState(null)
          const [notice, setNotice] = useState(null)
          const menuRef = useRef(null)
          const noticeTimer = useRef(0)

          useEffect(
            () =>
              bus.onNotice((text) => {
                setNotice(text)
                if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
                noticeTimer.current = window.setTimeout(() => setNotice(null), 3200)
              }),
            [],
          )

          useEffect(
            () => () => {
              if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
            },
            [],
          )

          useEffect(() => {
            const onContextMenu = (event) => {
              // Someone closer to the target already handled it.
              if (event.defaultPrevented) return
              try {
                if (menuRef.current && menuRef.current.contains(event.target)) return
                const selection = readSelection()
                if (!selection) return
                if (!clickInsideRange(event, selection.range)) return
                event.preventDefault()
                event.stopPropagation()
                setMenu({
                  x: event.clientX,
                  y: event.clientY,
                  text: selection.text,
                  description: selection.description,
                })
              } catch (error) {
                // Never let a selection quirk swallow the host's own menu.
                console.warn('[quote-selection] context menu failed', error)
              }
            }
            const onPointerDown = (event) => {
              if (menuRef.current && menuRef.current.contains(event.target)) return
              setMenu(null)
            }
            const onKeyDown = (event) => {
              if (event.key === 'Escape') {
                setMenu(null)
                return
              }
              if (event.defaultPrevented) return
              if (!isQuoteShortcut(event)) return
              const selection = readSelection()
              if (!selection) return
              event.preventDefault()
              event.stopPropagation()
              setMenu(null)
              commitQuote(selection.text, selection.description)
            }
            const onDismiss = () => setMenu(null)
            const onSelectionChange = () => {
              const selection = window.getSelection()
              if (!selection || selection.isCollapsed) setMenu(null)
            }

            document.addEventListener('contextmenu', onContextMenu, true)
            document.addEventListener('pointerdown', onPointerDown, true)
            document.addEventListener('keydown', onKeyDown, true)
            document.addEventListener('selectionchange', onSelectionChange)
            window.addEventListener('scroll', onDismiss, true)
            window.addEventListener('resize', onDismiss)
            return () => {
              document.removeEventListener('contextmenu', onContextMenu, true)
              document.removeEventListener('pointerdown', onPointerDown, true)
              document.removeEventListener('keydown', onKeyDown, true)
              document.removeEventListener('selectionchange', onSelectionChange)
              window.removeEventListener('scroll', onDismiss, true)
              window.removeEventListener('resize', onDismiss)
            }
          }, [])

          const quote = useCallback(() => {
            const current = menu
            setMenu(null)
            if (!current) return
            commitQuote(current.text, current.description)
          }, [menu])

          const copy = useCallback(async () => {
            const current = menu
            setMenu(null)
            if (!current) return
            const ok = await copyText(current.text)
            bus.notice(ok ? t('toast.copied') : t('toast.copyFailed'))
          }, [menu])

          const menuNode =
            menu === null
              ? null
              : h(
                  'div',
                  {
                    ref: menuRef,
                    role: 'menu',
                    'aria-label': t('menu.quote'),
                    className: 'qs-menu',
                    onMouseDown: (event) => event.preventDefault(),
                    onContextMenu: (event) => {
                      event.preventDefault()
                      event.stopPropagation()
                    },
                    style: {
                      left: Math.max(
                        8,
                        Math.min(menu.x, window.innerWidth - MENU_WIDTH - 8),
                      ),
                      top: Math.max(
                        8,
                        Math.min(menu.y, window.innerHeight - MENU_HEIGHT - 8),
                      ),
                      minWidth: MENU_WIDTH,
                    },
                  },
                  h(MenuItem, {
                    label: t('menu.copy'),
                    hint: copyShortcutLabel(),
                    onSelect: () => {
                      void copy()
                    },
                  }),
                  h(MenuItem, {
                    label: t('menu.quote'),
                    hint: quoteShortcutLabel(),
                    onSelect: quote,
                  }),
                )

          const noticeNode =
            notice === null
              ? null
              : h(
                  'div',
                  {
                    style: {
                      position: 'fixed',
                      left: '50%',
                      bottom: 96,
                      transform: 'translateX(-50%)',
                      padding: '6px 14px',
                      borderRadius: 999,
                      border: '0.5px solid var(--dsw-alias-border-l1)',
                      background: 'var(--dsw-alias-bg-layer-1)',
                      color: 'var(--dsw-alias-label-primary)',
                      fontSize: 12,
                      lineHeight: '18px',
                      boxShadow: '0 6px 20px rgba(0, 0, 0, 0.14)',
                      pointerEvents: 'none',
                    },
                  },
                  notice,
                )

          return h(React.Fragment, null, menuNode, noticeNode)
        }

        // ---------------------------------------------------------- bridge

        function QuoteBridge(props) {
          const actionsRef = useRef(null)
          const sessionRef = useRef(undefined)
          actionsRef.current = props && props.inputActions ? props.inputActions : null
          sessionRef.current = props && props.sessionId ? props.sessionId : undefined

          useEffect(() => {
            const drain = () => {
              const items = bus.drain()
              for (const item of items) {
                if (insertQuote(item, actionsRef.current, sessionRef.current)) continue
                void copyText(item.wireText).then((ok) => {
                  bus.notice(ok ? t('toast.busy') : t('toast.copyFailed'))
                })
              }
            }
            const dispose = bus.onInsert(drain)
            if (bus.pending() > 0) drain()
            return dispose
          }, [])

          return null
        }

        // ---------------------------------------------------------- message

        function QuoteText(props) {
          const data = props && props.node && props.node.data ? props.node.data : {}
          const location = typeof data.location === 'string' ? data.location : ''
          const body = typeof data.body === 'string' ? data.body : ''
          const tr = typeof props.t === 'function' ? props.t : t
          const interactive = props.interactive !== false
          const config = useSettingsSnapshot(settings)
          const [open, setOpen] = useState(false)
          const toggle = useCallback(() => setOpen((value) => !value), [])

          const role = typeof data.role === 'string' && data.role !== '' ? data.role : ''
          const preview = quotePreview(body, config.cardPreview)
          const roleSuffix = role === '' ? '' : '· ' + role
          const meta = tr('card.chars', { n: body.length })
          // The exact location is not the headline anymore: it stays available
          // on hover (and in the wire block the model reads).
          const hint = (location === '' ? preview : location + '\n' + preview) + '\n' +
            (open ? tr('card.collapse') : tr('card.expand'))
          // Hover styling is CSS-only (see QUOTE_CSS): the summary element is
          // replaced between the two states, so a JS hover flag would stick.
          const interactiveAttr = interactive ? 'true' : 'false'
          // Content first, then the count and the author as small emphatic tags.
          const summary = [
            h('span', { key: 'mark', className: CLS_MARK, 'aria-hidden': true }, '❝'),
            h(
              'span',
              { key: 'label', className: CLS_LABEL },
              preview === '' ? tr('menu.quote') : preview,
            ),
            h('span', { key: 'meta', className: CLS_META }, meta),
            roleSuffix === '' ? null : h('span', { key: 'role', className: CLS_ROLE }, roleSuffix),
            interactive
              ? h('span', { key: 'arrow', className: CLS_ARROW }, open ? '▾' : '▸')
              : null,
          ]

          if (!open) {
            const chipProps = {
              className: CLS_CHIP,
              'data-interactive': interactiveAttr,
              title: hint,
            }
            if (interactive) {
              chipProps.type = 'button'
              chipProps.onClick = toggle
              chipProps['aria-expanded'] = false
            }
            return h(
              'span',
              { style: { display: 'inline' } },
              h(interactive ? 'button' : 'span', chipProps, summary),
            )
          }

          const headerProps = {
            className: CLS_HEADER,
            'data-interactive': interactiveAttr,
            title: hint,
          }
          if (interactive) {
            headerProps.type = 'button'
            headerProps.onClick = toggle
            headerProps['aria-expanded'] = true
          }
          return h(
            'span',
            { style: { display: 'block' } },
            h(
              'span',
              { className: CLS_CARD },
              h(interactive ? 'button' : 'span', headerProps, summary),
              h('span', { className: CLS_BODY }, body),
            ),
          )
        }

        // ------------------------------------------------------ reading view

        /**
         * Reading-view block that contains at least one quote: render the typed
         * runs as plain text and each quote as the transcript card, so both
         * views fold the same content the same way. Blocks without a quote are
         * left to the reading view.
         * @param {{ matched?: { segments: Array<object> }, t?: Function }} props - chain match and locale seat.
         */
        function ReaderQuoteBlock(props) {
          const segments = props && props.matched && Array.isArray(props.matched.segments)
            ? props.matched.segments
            : null
          if (segments === null) return null
          return h(
            'span',
            { style: { display: 'block' } },
            segments.map((segment, index) => {
              if (segment.kind === 'quote') {
                return h(QuoteText, {
                  key: 'q' + index,
                  node: { data: segment.data },
                  interactive: true,
                  t: props.t,
                })
              }
              return h(
                'span',
                {
                  key: 't' + index,
                  style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
                },
                segment.text,
              )
            }),
          )
        }

        // --------------------------------------------------------- settings

        function SettingRow({ title, desc, control }) {
          return h(
            'div',
            { className: 'qs-setting' },
            h(
              'div',
              { className: 'qs-setting-text' },
              h('div', { className: 'qs-setting-title' }, title),
              h('div', { className: 'qs-setting-desc' }, desc),
            ),
            control,
          )
        }

        function NumberSetting({ label, value, onCommit }) {
          const [draft, setDraft] = useState(String(value))
          useEffect(() => setDraft(String(value)), [value])
          return h('input', {
            className: 'qs-number',
            type: 'number',
            min: PREVIEW_MIN,
            max: PREVIEW_MAX,
            step: 1,
            value: draft,
            'aria-label': label,
            onChange: (event) => {
              const next = event.target.value
              setDraft(next)
              const parsed = Number(next)
              if (next !== '' && Number.isFinite(parsed) && parsed >= PREVIEW_MIN && parsed <= PREVIEW_MAX) {
                onCommit(Math.round(parsed))
              }
            },
            onBlur: () => setDraft(String(value)),
          })
        }

        function QuoteSettings() {
          const config = useSettingsSnapshot(settings)
          const range = t('settings.range', { min: PREVIEW_MIN, max: PREVIEW_MAX })
          return h(
            'div',
            { className: 'qs-settings' },
            h(SettingRow, {
              title: t('settings.chip.title'),
              desc: t('settings.descWithRange', { desc: t('settings.chip.desc'), range }),
              control: h(NumberSetting, {
                label: t('settings.chip.title'),
                value: config.chipPreview,
                onCommit: (next) => settings.update({ chipPreview: next }),
              }),
            }),
            h(SettingRow, {
              title: t('settings.card.title'),
              desc: t('settings.descWithRange', { desc: t('settings.card.desc'), range }),
              control: h(NumberSetting, {
                label: t('settings.card.title'),
                value: config.cardPreview,
                onCommit: (next) => settings.update({ cardPreview: next }),
              }),
            }),
            h(SettingRow, {
              title: t('settings.shortcut.title'),
              desc: t('settings.shortcut.desc'),
              control: null,
            }),
          )
        }

        // ------------------------------------------------------ registration

        // The submit path expands every chip through its source codec
        // (`inputTriggers.serializeReference`), so the chip's source must exist
        // even though this plugin contributes no completion menu. An identity
        // codec is the whole contract: the chip already carries the model form.
        // The NUL trigger can never be typed, so no menu can open for it.
        ctx.effect(() => {
          const inputTriggers = ctx.get('inputTriggers')
          if (!inputTriggers || typeof inputTriggers.registerSource !== 'function') {
            console.warn('[quote-selection] inputTriggers unavailable; quote chips cannot be sent')
            return () => {}
          }
          return inputTriggers.registerSource({
            trigger: '\u0000',
            name: CHIP_SOURCE,
            order: 1000,
            candidates: () => [],
            codec: {
              clipboardText: (ref) => ref,
              serialize: (ref) => Promise.resolve(stripStaleQuote(ref)),
            },
          })
        }, 'quote-selection: reference source codec')

        // Core quoting first: the menu and the composer bridge must survive even
        // if a later, purely presentational registration is unavailable.
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: MENU_ID, order: 40 },
            QuoteMenu,
          ),
        )

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: BRIDGE_ID, order: 60 },
            QuoteBridge,
          ),
        )

        // Transcript folding: one business text node per sent quote block.
        ctx.effect(
          () =>
            ctx.uiConversation.userText.register({
              id: RULE_ID,
              order: 20,
              match: (text, from) => matchQuoteBlock(text, from),
            }),
          'quote-selection: user-text rule',
        )

        ctx.slots.inject('conversation.user.text.node', () =>
          ctx.slots.register(
            { name: 'conversation.user.text.node', key: RULE_ID, priority: 100, locale: NS },
            QuoteText,
          ),
        )

        // Plugin settings page (Settings → Quote selection). Client-side display
        // preferences only, so the values live in localStorage and apply live.
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'quote-selection',
              order: 26,
              label: () => t('settings.title'),
            },
            QuoteSettings,
          ),
        )

        // Reading view folding (dsh-better-display): it runs every rendered block
        // through this chain slot and falls back to its own rendering when no
        // entry claims the block. Claim only blocks that are entirely one quote,
        // so mixed messages keep the reading view's typography. Without that
        // plugin the slot never appears and this inject simply stays parked.
        ctx.slots.inject('dsh-better-display.block', () =>
          ctx.slots.register(
            {
              // A chain entry only requires `select`; keep the registration
              // minimal so an unexpected option cannot reject it.
              name: 'dsh-better-display.block',
              select: (owner) => {
                if (!owner || owner.source !== 'user' || !owner.block) return null
                const segments = splitQuoteSegments(owner.block.text)
                return segments === null ? null : { segments }
              },
            },
            ReaderQuoteBlock,
          ),
        )
      },
    }
  },
})
