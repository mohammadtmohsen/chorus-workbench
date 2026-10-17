export interface ReaderAnchor {
  readonly key: string
  readonly offset: number
}

function candidateRows(content: HTMLElement): HTMLElement[] {
  return [
    ...content.querySelectorAll<HTMLElement>(
      ':scope > [data-row-key], :scope > .turn > [data-row-key]'
    ),
  ]
}

export function readerAnchorOf(score: HTMLElement, content: HTMLElement): ReaderAnchor | null {
  if (score.clientHeight === 0) return null
  const rows = candidateRows(content)
  if (rows.length === 0) return null
  const top = score.getBoundingClientRect().top
  let low = 0
  let high = rows.length - 1
  while (low < high) {
    const middle = (low + high) >> 1
    const row = rows[middle]
    if (row !== undefined && row.getBoundingClientRect().bottom <= top) low = middle + 1
    else high = middle
  }
  const row = rows[low]
  const key = row?.dataset['rowKey']
  if (row === undefined || key === undefined) return null
  return { key, offset: Math.round(top - row.getBoundingClientRect().top) }
}

export function restoreReaderAnchor(
  score: HTMLElement,
  content: HTMLElement,
  anchor: ReaderAnchor
): boolean {
  const row = candidateRows(content).find((candidate) => candidate.dataset['rowKey'] === anchor.key)
  if (row === undefined) return false
  row.style.setProperty('content-visibility', 'visible')
  const target =
    score.scrollTop +
    row.getBoundingClientRect().top -
    score.getBoundingClientRect().top +
    anchor.offset
  if (target > score.scrollHeight - score.clientHeight) {
    row.style.removeProperty('content-visibility')
    return false
  }
  score.scrollTop = target
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      row.style.removeProperty('content-visibility')
    })
  )
  return true
}
