import { deckKeyAction, type KeyLike } from './keys'

function key(key: string, extra: Partial<KeyLike> = {}): KeyLike {
  return { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: document.body, ...extra }
}

describe('deck keyboard map (docs/ux.md §3)', () => {
  it('maps arrows and letters', () => {
    expect(deckKeyAction(key('ArrowRight'))).toBe('like')
    expect(deckKeyAction(key('l'))).toBe('like')
    expect(deckKeyAction(key('L'))).toBe('like')
    expect(deckKeyAction(key('ArrowLeft'))).toBe('dislike')
    expect(deckKeyAction(key('h'))).toBe('dislike')
    expect(deckKeyAction(key('o'))).toBe('open')
    expect(deckKeyAction(key('?'))).toBe('help')
    expect(deckKeyAction(key('Escape'))).toBe('close')
    expect(deckKeyAction(key('x'))).toBeNull()
  })

  it('undoes with Z, ⌘Z and Ctrl+Z but leaves ⌘⇧Z and other shortcuts alone', () => {
    expect(deckKeyAction(key('z'))).toBe('undo')
    expect(deckKeyAction(key('z', { metaKey: true }))).toBe('undo')
    expect(deckKeyAction(key('z', { ctrlKey: true }))).toBe('undo')
    expect(deckKeyAction(key('z', { metaKey: true, shiftKey: true }))).toBeNull()
    expect(deckKeyAction(key('ArrowRight', { metaKey: true }))).toBeNull()
    expect(deckKeyAction(key('l', { altKey: true }))).toBeNull()
  })

  it('expands with Space / Enter except on buttons and links, which keep their native meaning', () => {
    expect(deckKeyAction(key(' '))).toBe('toggle')
    expect(deckKeyAction(key('Enter'))).toBe('toggle')
    const button = document.createElement('button')
    const link = document.createElement('a')
    link.href = '/liked'
    expect(deckKeyAction(key(' ', { target: button }))).toBeNull()
    expect(deckKeyAction(key('Enter', { target: link }))).toBeNull()
    // Arrows still work while a button has focus.
    expect(deckKeyAction(key('ArrowRight', { target: button }))).toBe('like')
  })

  it('never fires while typing', () => {
    const input = document.createElement('input')
    const textarea = document.createElement('textarea')
    expect(deckKeyAction(key('l', { target: input }))).toBeNull()
    expect(deckKeyAction(key('z', { target: textarea }))).toBeNull()
    expect(deckKeyAction(key('ArrowRight', { isComposing: true }))).toBeNull()
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    expect(deckKeyAction(key('l', { target: checkbox }))).toBe('like')
  })
})
