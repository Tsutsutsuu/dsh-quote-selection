/**
 * Static reference audit for the client bundle: reports declared identifiers
 * (prefix constants, CSS class names, locale keys) that are never referenced
 * anywhere else in the file. A count of 1 means "declared but unused".
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

/** Count whole-word occurrences. */
function count(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (source.match(new RegExp(`\\b${escaped}\\b`, 'g')) ?? []).length
}

const constants = [
  'NS', 'MENU_ID', 'BRIDGE_ID', 'RULE_ID', 'CHIP_SOURCE', 'MAX_QUOTE_CHARS',
  'CLICK_SLOP_PX', 'MENU_WIDTH', 'MENU_HEIGHT', 'PENDING_TTL_MS', 'ROW_SELECTOR',
  'QUOTE_OPEN', 'QUOTE_CLOSE', 'CHIP_PREVIEW_CHARS', 'CARD_PREVIEW_CHARS',
  'SETTINGS_KEY', 'SETTINGS_DEFAULT', 'PREVIEW_MIN', 'PREVIEW_MAX', 'ROLE_LABELS',
  'BLOCK_TAGS', 'EN', 'ZH', 'CLS_CHIP', 'CLS_CARD', 'CLS_HEADER', 'CLS_BODY',
  'CLS_MARK', 'CLS_LABEL', 'CLS_ROLE', 'CLS_META', 'CLS_ARROW', 'STYLE_TAG',
  'CHIP_SEL', 'CHIP_INNER', 'QUOTE_CSS',
]

const cssClasses = [
  'qs-quote-chip', 'qs-quote-card', 'qs-quote-header', 'qs-quote-body',
  'qs-quote-mark', 'qs-quote-label', 'qs-quote-role', 'qs-quote-meta',
  'qs-quote-arrow', 'qs-menu', 'qs-menu-item', 'qs-menu-item-label',
  'qs-menu-item-hint', 'qs-settings', 'qs-setting', 'qs-setting-text',
  'qs-setting-title', 'qs-setting-desc', 'qs-number',
]

const localeKeys = [
  'menu.quote', 'menu.copy', 'card.expand', 'card.collapse', 'card.chars',
  'toast.copied', 'toast.copyFailed', 'toast.busy', 'settings.title',
  'settings.chip.title', 'settings.chip.desc', 'settings.card.title',
  'settings.card.desc', 'settings.range', 'settings.descWithRange',
  'settings.shortcut.title', 'settings.shortcut.desc',
]

const unusedConstants = constants.filter((name) => count(name) <= 1)
const unusedClasses = cssClasses.filter((name) => count(name) <= 1)
const unusedKeys = localeKeys.filter((key) => count(key) < 3) // definition + t() call(s)

console.log('unused constants:', unusedConstants.length ? unusedConstants.join(', ') : '(none)')
console.log('unused css classes:', unusedClasses.length ? unusedClasses.join(', ') : '(none)')
console.log('locale keys without a call site:', unusedKeys.length ? unusedKeys.join(', ') : '(none)')

// Locale parity between EN and ZH.
const en = source.slice(source.indexOf('const EN = {'), source.indexOf('const ZH = {'))
const zh = source.slice(source.indexOf('const ZH = {'), source.indexOf('// ---------------------------------------------------------------- helpers'))
const keysOf = (block) => new Set([...block.matchAll(/'([a-z][\w.]*)':/g)].map((m) => m[1]))
const enKeys = keysOf(en)
const zhKeys = keysOf(zh)
const missingInZh = [...enKeys].filter((key) => !zhKeys.has(key))
const missingInEn = [...zhKeys].filter((key) => !enKeys.has(key))
console.log('locale keys missing in ZH:', missingInZh.length ? missingInZh.join(', ') : '(none)')
console.log('locale keys missing in EN:', missingInEn.length ? missingInEn.join(', ') : '(none)')
