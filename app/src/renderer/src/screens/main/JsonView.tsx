type Kind = 'key' | 'string' | 'number' | 'plain'

interface Token {
  text: string
  kind: Kind
}

const TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g

const COLORS: Record<Kind, string> = {
  key: 'text-accent',
  string: 'text-emerald-700 dark:text-emerald-400',
  number: 'text-amber-700 dark:text-amber-300',
  plain: 'text-muted'
}

/** Quebra o JSON em pedaços coloridos sem HTML cru (nada de dangerouslySetInnerHTML). */
export function tokenize(json: string): Token[] {
  const tokens: Token[] = []
  let last = 0
  for (const match of json.matchAll(TOKEN)) {
    if (match.index > last) tokens.push({ text: json.slice(last, match.index), kind: 'plain' })
    const [whole, text, colon, number] = match
    if (number !== undefined) tokens.push({ text: number, kind: 'number' })
    else if (colon === undefined) tokens.push({ text: whole, kind: 'string' })
    else tokens.push({ text: String(text), kind: 'key' }, { text: colon, kind: 'plain' })
    last = match.index + whole.length
  }
  if (last < json.length) tokens.push({ text: json.slice(last), kind: 'plain' })
  return tokens
}

export function JsonView({ json }: { json: string }) {
  return (
    <pre className="p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap">
      {tokenize(json).map((token, index) => (
        <span key={index} data-token={token.kind} className={COLORS[token.kind]}>
          {token.text}
        </span>
      ))}
    </pre>
  )
}
