import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  MonitorVolumeSlider,
  SystemAudioWarning
} from '../../../src/renderer/src/screens/live/MonitorVolume'
import { FakeApi } from '../fake-api'
import { renderWithApp } from '../render'

const LOW = { sink: 'Fone USB', percent: 8, muted: false }

describe('MonitorVolumeSlider', () => {
  it('arrastar salva só o último valor, uma vez', async () => {
    const api = new FakeApi()
    api.live.monitorVolume.mockResolvedValue(LOW)
    await renderWithApp(<MonitorVolumeSlider />, { api, init: false })
    const slider = await screen.findByRole('slider')
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      fireEvent.change(slider, { target: { value: '40' } })
      fireEvent.change(slider, { target: { value: '70' } })
      expect(slider).toHaveValue('70')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })
    } finally {
      vi.useRealTimers()
    }
    expect(api.live.setMonitorVolume).toHaveBeenCalledTimes(1)
    expect(api.live.setMonitorVolume).toHaveBeenCalledWith(70)
  })

  it('mudo aparece como 0%; sair antes de salvar não ajusta nada', async () => {
    const api = new FakeApi()
    api.live.monitorVolume.mockResolvedValue({ ...LOW, muted: true })
    const { unmount } = await renderWithApp(<MonitorVolumeSlider />, { api, init: false })
    const slider = await screen.findByRole('slider')
    expect(slider).toHaveValue('0')
    fireEvent.change(slider, { target: { value: '90' } })
    unmount()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(api.live.setMonitorVolume).not.toHaveBeenCalled()
  })
})

describe('SystemAudioWarning', () => {
  it('sair antes da leitura chegar não mexe na tela desmontada', async () => {
    const api = new FakeApi()
    let resolve: (value: typeof LOW) => void = () => undefined
    api.live.monitorVolume.mockReturnValue(
      new Promise((ok) => {
        resolve = ok
      })
    )
    const { unmount } = await renderWithApp(<SystemAudioWarning level={0} />, { api, init: false })
    unmount()
    resolve(LOW)
    await waitFor(() => {
      expect(api.live.monitorVolume).toHaveBeenCalledTimes(1)
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('sem saber o sistema ainda, avisa sem a dica do macOS', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await renderWithApp(<SystemAudioWarning level={0} />, { init: false })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000)
      })
      expect(screen.getByText(/Nenhum som do computador/)).toBeInTheDocument()
      expect(screen.queryByText(/Gravação de tela/)).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})
