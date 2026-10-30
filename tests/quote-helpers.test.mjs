/**
 * Smoke test for the pure location/formatting/parsing helpers of the Quote
 * Selection client bundle.
 *
 * The browser bundle is a single `window.__ModuleLoader__` artifact, so it
 * cannot export anything for tests. Instead this test slices the real helper
 * section out of `plugin/client.js` and evaluates it with tiny DOM stand-ins —
 * the assertions therefore run against the shipping source text, not a copy.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

// Slice from the first constant so BLOCK_TAGS / CLICK_SLOP_PX / QUOTE_* /
// MAX_QUOTE_CHARS come along with the helpers they configure.
const START = "const NS = 'quote-selection'"
const END = '// ------------------------------------------------------------------- bus'
const startAt = source.indexOf(START)
const endAt = source.indexOf(END)
assert.ok(startAt >= 0 && endAt > startAt, 'helper section markers must exist in client.js')
const helpers = source.slice(startAt, endAt)

/** Evaluate the sliced helpers with DOM stand-ins. */
function loadHelpers() {
  const documentStub = {
    /** Range stand-in: text length between two (fake) node positions. */
    createRange() {
      let text = ''
      return {
        selectNodeContents(node) {
          text = node.textContent ?? ''
        },
        setEnd() {
          // Real measurement is exercised in the browser; the helpers only need
          // to not throw here.
        },
        toString() {
          return text
        },
      }
    },
  }
  const windowStub = { getSelection: () => null }
  const navigatorStub = { clipboard: { writeText: async () => {} } }
  const factory = new Function(
    'document',
    'window',
    'navigator',
    'console',
    `${helpers}\nreturn { outermostBlock, blockIndex, normalizeQuoteText, quotePreview, formatQuote, formatQuoteChipLabel, stripStaleQuote, matchQuoteBlock, splitQuoteSegments, rowOf, describeRow, readerKindOf, clickInsideRange, isQuoteShortcut, isMacPlatform, quoteShortcutLabel, copyShortcutLabel, QUOTE_OPEN, QUOTE_CLOSE }`,
  )
  return factory(documentStub, windowStub, navigatorStub, console)
}

const api = loadHelpers()

/**
 * Whether one simple `[attr]` selector matches a fake element.
 * @param {string} selector - selector to test.
 * @param {any} node - fake element.
 */
function matches(selector, node) {
  const m = /^\[([^\]]+)\]$/.exec(selector.trim())
  if (m === null) throw new Error(`unsupported selector ${selector}`)
  return Boolean(node.attrs && m[1] in node.attrs)
}

/** Split a comma selector list. */
function selectorsOf(selector) {
  return String(selector)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

/**
 * Build a fake element tree node.
 * @param {string} tagName - tag.
 * @param {{ children?: any[], attrs?: Record<string, string> }} [options]
 * @returns {any} fake element.
 */
function element(tagName, options = {}) {
  const attrs = options.attrs ?? {}
  const children = options.children ?? []
  const node = {
    nodeType: 1,
    // Real DOMs upper-case tagName; the helpers compare against upper-case tags.
    tagName: String(tagName).toUpperCase(),
    children,
    attrs,
    parentElement: null,
    textContent: '',
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    closest(selector) {
      const selectors = selectorsOf(selector)
      let current = node
      while (current) {
        if (current.attrs && selectors.some((sel) => matches(sel, current))) return current
        current = current.parentElement
      }
      return null
    },
    querySelector(selector) {
      const selectors = selectorsOf(selector)
      const walk = (root) => {
        for (const child of root.children) {
          if (child.attrs && selectors.some((sel) => matches(sel, child))) return child
          const found = walk(child)
          if (found) return found
        }
        return null
      }
      return walk(node)
    },
  }
  for (const child of children) child.parentElement = node
  return node
}

/** A text node stand-in. */
function textNode(parent) {
  return { nodeType: 3, parentElement: parent }
}

test('normalizeQuoteText trims edges and collapses blank runs', () => {
  assert.deepEqual(api.normalizeQuoteText('  a\r\n\r\n\r\n  b  '), {
    text: 'a\n\n  b',
    truncated: false,
  })
  assert.deepEqual(api.normalizeQuoteText(' \n\t\n '), { text: '', truncated: false })
})

test('normalizeQuoteText caps very long selections', () => {
  const long = 'x'.repeat(4200)
  const result = api.normalizeQuoteText(long)
  assert.equal(result.truncated, true)
  assert.equal(result.text.length, 4000)
})

test('formatQuote renders the documented wire block', () => {
  const description = { short: '助手消息 · 第3轮', parts: ['助手消息', '第3轮', '第2/5段', '字符12–30'] }
  assert.equal(
    api.formatQuote(description, 'line one\nline two', false),
    '【引用 · 助手消息 · 第3轮 · 第2/5段 · 字符12–30】\nline one\nline two\n【/引用】\n',
  )
  const truncated = api.formatQuote(description, 'cut', true)
  assert.match(truncated, /^【引用 · 助手消息/)
  assert.match(truncated, /引用已截断，共 4000 字符/)
  assert.match(truncated, /\n【\/引用】\n$/)
})

test('quotePreview flattens whitespace and ellipsizes past the cap', () => {
  assert.equal(api.quotePreview('line one\nline  two', 40), 'line one line two')
  assert.equal(api.quotePreview('  padded  ', 40), 'padded')
  assert.equal(api.quotePreview('abcdefghij', 4), 'abcd…')
  assert.equal(api.quotePreview('short', 10), 'short')
  assert.equal(api.quotePreview(null, 10), '')
})

test('formatQuoteChipLabel leads with content, then count, then author', () => {
  const description = { role: '助手消息', short: '助手消息 第3轮', parts: ['助手消息'] }
  const body = '它把 location 写进了 wire 文本里，界面只做折叠。'
  // Default preview length is the settings default (12 characters); three
  // spaces separate the preview from the count, the author trails after `·`.
  assert.equal(
    api.formatQuoteChipLabel(description, body),
    body.slice(0, 12) + '…   ' + body.length + ' 字 · 助手消息',
  )
  // A settings override changes only the preview length.
  assert.equal(
    api.formatQuoteChipLabel(description, 'abcdefghijklmnop', 4),
    'abcd…   16 字 · 助手消息',
  )
  // No role falls back to a neutral label rather than an empty string.
  assert.equal(api.formatQuoteChipLabel({}, 'body'), 'body   4 字 · 消息')
})

test('stripStaleQuote serializes a current chip and drops a stale one', () => {
  const wire = api.formatQuote({ short: 'x', parts: ['助手消息'] }, 'quoted body', false)
  assert.equal(api.stripStaleQuote(wire), wire)
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    // A chip from the previous build carries only an opaque id.
    assert.equal(api.stripStaleQuote('quote-abc123'), '')
    assert.equal(api.stripStaleQuote(undefined), '')
  } finally {
    console.warn = originalWarn
  }
})

test('matchQuoteBlock round-trips a formatted block', () => {
  const description = { short: '助手消息 · 第3轮', parts: ['助手消息', '第3轮', '第2/5段', '字符12–30'] }
  const wire = api.formatQuote(description, 'first line\nsecond line', false)
  const text = wire + '我的问题'
  const node = api.matchQuoteBlock(text, 0)
  assert.equal(node.id, 'quote')
  assert.equal(node.start, 0)
  assert.equal(node.end, wire.trimEnd().length)
  assert.equal(node.data.location, '助手消息 · 第3轮 · 第2/5段 · 字符12–30')
  assert.equal(node.data.role, '助手消息')
  assert.equal(node.data.body, 'first line\nsecond line')
  assert.equal(text.slice(node.end), '\n我的问题')
})

test('matchQuoteBlock finds the next block after a given offset', () => {
  const wire = api.formatQuote({ short: 'x', parts: ['用户消息'] }, 'body', false)
  const text = 'hello ' + wire + ' middle ' + wire
  const first = api.matchQuoteBlock(text, 0)
  assert.equal(first.start, 6)
  const second = api.matchQuoteBlock(text, first.end)
  assert.ok(second.start > first.end)
  assert.equal(second.data.body, 'body')
})

test('matchQuoteBlock ignores malformed or unclosed markers', () => {
  assert.equal(api.matchQuoteBlock('no quote here', 0), undefined)
  assert.equal(api.matchQuoteBlock('【引用 · 助手消息】\nbody without close', 0), undefined)
  assert.equal(api.matchQuoteBlock('【引用 · 】\nbody\n【/引用】', 0), undefined)
})

test('splitQuoteSegments splits typed runs from quote cards', () => {
  const wire = api.formatQuote({ role: '用户消息', parts: ['用户消息'] }, 'quoted lines', false)

  // A block that is only a quote.
  const only = api.splitQuoteSegments(wire)
  assert.equal(only.length, 1)
  assert.equal(only[0].kind, 'quote')
  assert.equal(only[0].data.body, 'quoted lines')

  // Quote + typed words: both sides are kept, the quote becomes a card.
  const mixed = api.splitQuoteSegments(`测试一下${wire}`)
  assert.deepEqual(mixed.map((segment) => segment.kind), ['text', 'quote'])
  assert.equal(mixed[0].text, '测试一下')

  // Text after the quote survives too (leading newline from the wire block kept).
  const trailing = api.splitQuoteSegments(`${wire}顺便问一句`)
  assert.deepEqual(trailing.map((segment) => segment.kind), ['quote', 'text'])
  assert.equal(trailing[1].text.trim(), '顺便问一句')

  // Two quotes with text between them.
  const twice = api.splitQuoteSegments(`a${wire}b${wire}c`)
  assert.deepEqual(twice.map((segment) => segment.kind), ['text', 'quote', 'text', 'quote', 'text'])

  // No quote at all: the reading view keeps its own rendering.
  assert.equal(api.splitQuoteSegments('plain text'), null)
  assert.equal(api.splitQuoteSegments(''), null)
  assert.equal(api.splitQuoteSegments(undefined), null)
})

test('rowOf finds the chat flow row from a text node', () => {
  const row = element('div', { attrs: { 'data-chat-flow-key': 'k1', 'data-chat-flow-kind': 'assistant-step' } })
  const paragraph = element('p')
  const inline = element('span')
  row.children.push(paragraph)
  paragraph.parentElement = row
  paragraph.children.push(inline)
  inline.parentElement = paragraph
  const text = textNode(inline)

  assert.equal(api.rowOf(text), row)
  assert.equal(api.rowOf(row), row)
  assert.equal(api.rowOf(element('p')), null)
})

test('rowOf and describeRow fall back to the reading view anchors', () => {
  // <section data-reader-turn="7"> <article data-reader-answer data-reader-anchor> <p> … </p> </article> </section>
  const turn = element('section', { attrs: { 'data-reader-turn': '7' } })
  const answer = element('article', {
    attrs: { 'data-reader-answer': '', 'data-reader-anchor': '', 'data-chat-flow-kind': 'assistant-step' },
  })
  const paragraph = element('p')
  const inline = element('span')
  turn.children.push(answer)
  answer.parentElement = turn
  answer.children.push(paragraph)
  paragraph.parentElement = answer
  paragraph.children.push(inline)
  inline.parentElement = paragraph
  const text = textNode(inline)

  assert.equal(api.rowOf(text), answer)
  const located = api.describeRow(text)
  assert.equal(located.row, answer)
  assert.equal(located.kind, 'assistant-step')
  assert.equal(located.turn, '7')
})

test('describeRow reads the reading view turn without a known node kind', () => {
  const turn = element('section', { attrs: { 'data-reader-turn': '4' } })
  const user = element('div', { attrs: { 'data-reader-anchor': '' } })
  const paragraph = element('p')
  turn.children.push(user)
  user.parentElement = turn
  user.children.push(paragraph)
  paragraph.parentElement = user
  const text = textNode(paragraph)

  const located = api.describeRow(text)
  assert.equal(located.row, user)
  assert.equal(located.kind, 'user')
  assert.equal(located.turn, '4')
})

test('describeRow ignores an unresolved reading-view turn', () => {
  const turn = element('section', { attrs: { 'data-reader-turn': 'unresolved' } })
  const paragraph = element('p')
  turn.children.push(paragraph)
  paragraph.parentElement = turn

  const located = api.describeRow(textNode(paragraph))
  assert.equal(located.row, turn)
  assert.equal(located.turn, '')
})

test('describeRow falls back to the transcript scroller when no row marker exists', () => {
  const scroller = element('div', { attrs: { 'data-conversation-scroll': '' } })
  const paragraph = element('p')
  scroller.children.push(paragraph)
  paragraph.parentElement = scroller

  const located = api.describeRow(textNode(paragraph))
  assert.equal(located.row, scroller)
  assert.equal(located.kind, '')
  assert.equal(located.turn, '')
})

test('readerKindOf maps reading-view anchors to chat kinds', () => {
  const turn = element('section', { attrs: { 'data-reader-turn': '3' } })
  // The user's message renders as the turn's first anchor.
  const userCluster = element('div', { attrs: { 'data-reader-anchor': '' } })
  const answer = element('article', { attrs: { 'data-reader-answer': '', 'data-reader-anchor': '' } })
  const reasoning = element('div', { attrs: { 'data-reader-reasoning-card': '', 'data-reader-anchor': '' } })
  const tool = element('div', { attrs: { 'data-reader-tool-call': '' } })
  const paragraph = element('p')
  turn.children.push(userCluster, answer, reasoning, tool)
  userCluster.parentElement = turn
  answer.parentElement = turn
  reasoning.parentElement = turn
  tool.parentElement = turn
  answer.children.push(paragraph)
  paragraph.parentElement = answer

  assert.equal(api.readerKindOf(userCluster), 'user')
  assert.equal(api.readerKindOf(paragraph), 'assistant-step')
  assert.equal(api.readerKindOf(reasoning), 'assistant-step')
  assert.equal(api.readerKindOf(tool), 'tool-call')
})

test('outermostBlock picks the paragraph and blockIndex numbers it', () => {
  const row = element('div', { attrs: { 'data-chat-flow-key': 'k1' } })
  const first = element('p')
  const second = element('p')
  const inline = element('code')
  row.children.push(first, second)
  first.parentElement = row
  second.parentElement = row
  second.children.push(inline)
  inline.parentElement = second

  const text = textNode(inline)
  const block = api.outermostBlock(text, row)
  assert.equal(block, second)
  assert.deepEqual(api.blockIndex(block), { index: 2, total: 2 })
})

test('outermostBlock prefers the enclosing list item over its paragraph', () => {
  const row = element('div', { attrs: { 'data-chat-flow-key': 'k1' } })
  const list = element('ul')
  const itemOne = element('li')
  const itemTwo = element('li')
  const paragraph = element('p')
  row.children.push(list)
  list.parentElement = row
  list.children.push(itemOne, itemTwo)
  itemOne.parentElement = list
  itemTwo.parentElement = list
  itemTwo.children.push(paragraph)
  paragraph.parentElement = itemTwo
  const inline = element('span')
  paragraph.children.push(inline)
  inline.parentElement = paragraph

  const block = api.outermostBlock(textNode(inline), row)
  assert.equal(block, itemTwo)
  assert.deepEqual(api.blockIndex(block), { index: 2, total: 2 })
})

test('blockIndex ignores a lone block', () => {
  const parent = element('div')
  const only = element('p')
  parent.children.push(only)
  only.parentElement = parent
  assert.equal(api.blockIndex(only), null)
})

test('isQuoteShortcut accepts Ctrl+Q, Ctrl+Shift+Q and Cmd variants only', () => {
  const key = (over) => ({ code: 'KeyQ', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...over })
  assert.equal(api.isQuoteShortcut(key({ ctrlKey: true }), false), true)
  assert.equal(api.isQuoteShortcut(key({ ctrlKey: true, shiftKey: true }), false), true)
  assert.equal(api.isQuoteShortcut(key({ metaKey: true, shiftKey: true }), true), true)
  // macOS: plain ⌘Q quits the app, so it must not be taken.
  assert.equal(api.isQuoteShortcut(key({ metaKey: true }), true), false)
  // No primary modifier, wrong key, or Alt held: not the shortcut.
  assert.equal(api.isQuoteShortcut(key({}), false), false)
  assert.equal(api.isQuoteShortcut(key({ shiftKey: true }), false), false)
  assert.equal(api.isQuoteShortcut(key({ ctrlKey: true, altKey: true }), false), false)
  assert.equal(api.isQuoteShortcut({ ...key({ ctrlKey: true }), code: 'KeyW' }, false), false)
})

test('platform labels adapt the shortcut hints', () => {
  assert.equal(api.isMacPlatform({ platform: 'MacIntel', userAgent: '' }), true)
  assert.equal(api.isMacPlatform({ platform: 'Win32', userAgent: 'Windows' }), false)
  assert.equal(api.isMacPlatform(undefined), false)
  assert.equal(api.quoteShortcutLabel(true), '⌘⇧Q')
  assert.equal(api.quoteShortcutLabel(false), 'Ctrl+Q')
  assert.equal(api.copyShortcutLabel(true), '⌘C')
  assert.equal(api.copyShortcutLabel(false), 'Ctrl+C')
})

test('clickInsideRange only accepts a pointer on selected glyphs', () => {
  const range = {
    getClientRects: () => [
      { left: 100, right: 200, top: 50, bottom: 70, width: 100, height: 20 },
    ],
  }
  assert.equal(api.clickInsideRange({ clientX: 150, clientY: 60 }, range), true)
  assert.equal(api.clickInsideRange({ clientX: 98, clientY: 60 }, range), true)
  assert.equal(api.clickInsideRange({ clientX: 150, clientY: 200 }, range), false)
  assert.equal(api.clickInsideRange({ clientX: 400, clientY: 60 }, range), false)
})
