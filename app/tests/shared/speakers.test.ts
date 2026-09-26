import { describe, expect, it } from 'vitest'
import { resolveSpeakerLabels, SPEAKER_LABELS, speakerLabelsFor } from '../../src/shared/speakers'

describe('speaker labels', () => {
  it('define os rótulos traduzidos dos três idiomas de interface', () => {
    expect(SPEAKER_LABELS).toEqual({
      'pt-BR': { voce: 'Você', outros: 'Outros' },
      en: { voce: 'You', outros: 'Others' },
      es: { voce: 'Tú', outros: 'Otros' }
    })
    expect(speakerLabelsFor('es')).toEqual({ voce: 'Tú', outros: 'Otros' })
  })

  it('usa o uiLanguage configurado quando existe', () => {
    expect(resolveSpeakerLabels('en', 'de-DE')).toEqual({ voce: 'You', outros: 'Others' })
    expect(resolveSpeakerLabels('es', 'pt-BR')).toEqual({ voce: 'Tú', outros: 'Otros' })
  })

  it('segue o locale do sistema quando o uiLanguage é nulo', () => {
    expect(resolveSpeakerLabels(null, 'pt-PT')).toEqual({ voce: 'Você', outros: 'Outros' })
    expect(resolveSpeakerLabels(null, 'es-419')).toEqual({ voce: 'Tú', outros: 'Otros' })
    expect(resolveSpeakerLabels(null, 'en-GB')).toEqual({ voce: 'You', outros: 'Others' })
  })

  it('cai para pt-BR em locale desconhecido ou ausente', () => {
    expect(resolveSpeakerLabels(null, 'de-DE')).toEqual({ voce: 'Você', outros: 'Outros' })
    expect(resolveSpeakerLabels(null)).toEqual({ voce: 'Você', outros: 'Outros' })
    expect(resolveSpeakerLabels(null, '')).toEqual({ voce: 'Você', outros: 'Outros' })
  })
})
