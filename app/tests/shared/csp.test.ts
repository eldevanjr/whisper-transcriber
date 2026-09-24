import { describe, expect, it } from 'vitest'
import { allowDevInlineScripts } from '../../src/shared/csp'

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'"

describe('allowDevInlineScripts', () => {
  it('libera scripts inline só em script-src (preâmbulo do React Refresh no dev)', () => {
    const html = `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`
    expect(allowDevInlineScripts(html)).toBe(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'" />`
    )
  })

  it('sem script-src restrito não mexe no HTML', () => {
    expect(allowDevInlineScripts('<p>oi</p>')).toBe('<p>oi</p>')
  })
})
