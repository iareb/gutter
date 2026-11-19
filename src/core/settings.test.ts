import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, loadSettings, parseSettings, saveSettings } from './settings'

describe('settings', () => {
  it('starts from the defaults', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS).toEqual({ direction: 'ltr', mode: 'single', cover: true })
  })

  it('reads what was saved', () => {
    expect(parseSettings('{"direction":"rtl","mode":"single"}')).toEqual({
      direction: 'rtl',
      mode: 'single',
      cover: true,
    })
  })

  it('reads the double page mode and the cover', () => {
    expect(parseSettings('{"mode":"double","cover":false}')).toEqual({
      direction: 'ltr',
      mode: 'double',
      cover: false,
    })
  })

  it('keeps the default for anything broken or unknown', () => {
    expect(parseSettings('not json')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('42')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('{"direction":"up","mode":"vertical"}')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('{"direction":"rtl","extra":1}')).toEqual({
      direction: 'rtl',
      mode: 'single',
      cover: true,
    })
  })

  it('saves and loads through a storage, and survives a storage that refuses', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    }
    saveSettings({ direction: 'rtl', mode: 'single', cover: true }, storage)
    expect(loadSettings(storage)).toEqual({ direction: 'rtl', mode: 'single', cover: true })
    const refusing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    }
    expect(loadSettings(refusing)).toEqual(DEFAULT_SETTINGS)
    expect(() => saveSettings(DEFAULT_SETTINGS, refusing)).not.toThrow()
  })
})
