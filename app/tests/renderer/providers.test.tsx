import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useApi, useAppStore, useLiveMedia } from '../../src/renderer/src/providers'

function UsesApi() {
  useApi()
  return null
}

function UsesStore() {
  useAppStore((s) => s.ready)
  return null
}

function UsesMedia() {
  useLiveMedia()
  return null
}

describe('providers', () => {
  it('hooks fora do AppProviders avisam claramente', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined) // o React loga o erro
    expect(() => render(<UsesApi />)).toThrow('useApi usado fora do AppProviders')
    expect(() => render(<UsesStore />)).toThrow('useAppStore usado fora do AppProviders')
    expect(() => render(<UsesMedia />)).toThrow('useLiveMedia usado fora do AppProviders')
  })
})
