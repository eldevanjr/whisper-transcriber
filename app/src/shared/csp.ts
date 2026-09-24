/**
 * Só no servidor de desenvolvimento: o React Refresh injeta um script inline (o "preâmbulo") que a
 * CSP `script-src 'self'` bloqueia — sem ele o renderer não monta. O build mantém a CSP estrita.
 */
export function allowDevInlineScripts(html: string): string {
  return html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")
}
