import { useEffect, useMemo, useState } from 'react'
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useDroppable,
  useDraggable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import type { Card, RankingTable, Snapshot } from './types'

const STORAGE_KEY = 'collect-and-conquer-tables-v2'
const SELECTED_KEY = 'collect-and-conquer-selected-v2'
const UI_KEY = 'collect-and-conquer-ui-v2'
const BASE = import.meta.env.BASE_URL

const PRESETS = [
  {
    id: 'friends-ranking',
    title: "Friend's Ranking",
    ranked: [
      'The Theorist, Jace Beleren', 'Samut, Tyrant of Naktamun', "Samut, Hazoret's Champion", 'Bloodline Recollector',
      'Flickering Hound', 'Hexhaven Invigorator', "Ajani's Anguish", 'Draconic Visitor', 'Curse-Marred Demon', 'Verdant Kraken',
    ],
    honorable: ['Craterclaw Colossus', "Lich's Relic", 'Carnivorous Cultivator', 'Karn, Argent Defender', 'Emrakul, the Exigent Doom', 'Niv-Mizzet, Ghost Counsel', 'Vraska, Soul of Stone'],
  },
  {
    id: 'bracket-3',
    title: 'Bracket 3',
    ranked: ['Kwia Vigorbloom', 'The Theorist, Jace Beleren', 'Hexhaven Invigorator', 'Draconic Visitor', 'Samut, Tyrant of Naktamun', 'Craterclaw Colossus', 'Aerid Konstrari', 'Enlightened Confidant', 'Flickering Hound', 'Vraska, Soul of Stone'],
    honorable: ['Bloodline Recollector', 'Omnipresence', 'Ajani Resolute', 'The Ur-Sphinx', 'Karn, Argent Defender'],
  },
  {
    id: 'cedh-watch-list',
    title: 'cEDH Watch List',
    ranked: ['Samut, Tyrant of Naktamun', 'Karn, Argent Defender', 'Stingcaster Mage', 'Bloodline Recollector', 'Chandra, Chill of Compliance'],
    honorable: ['Divining Duelist', 'Mabel, Valley Hero'],
  },
] as const

function makeId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function resolveName(name: string, cards: Card[]) {
  const exact = cards.find((card) => card.name === name)
  if (exact) return exact.id
  const loose = name.toLowerCase().replace(/[’']/g, '')
  return cards.find((card) => {
    const canonicalName = card.name.split(' // ')[0]
    return canonicalName.toLowerCase().replace(/[’']/g, '') === loose
  })?.id || null
}

function buildInitialTables(cards: Card[]): RankingTable[] {
  return PRESETS.map((preset) => ({
    id: preset.id,
    title: preset.title,
    visible: true,
    compact: false,
    size: 10,
    ranked: Array.from({ length: 10 }, (_, index) => resolveName(preset.ranked[index] || '', cards)),
    honorable: [...preset.honorable.map((name) => resolveName(name, cards)), ...(preset.id === 'friends-ranking' ? cards.filter((card) => card.typeLine.includes('Elder Sphinx')).map((card) => card.id) : [])]
      .filter((id): id is string => Boolean(id))
      .filter((id, index, values) => values.indexOf(id) === index),
    staged: [],
  }))
}

function normalizeTables(value: unknown, cards: Card[]): RankingTable[] | null {
  if (!Array.isArray(value)) return null
  const valid = new Set(cards.map((card) => card.id))
  const next = value.filter((table): table is RankingTable => Boolean(table && typeof table === 'object' && typeof (table as RankingTable).id === 'string')).map((table) => ({
    id: table.id,
    title: typeof table.title === 'string' && table.title.trim() ? table.title : 'Ranking',
    visible: table.visible !== false,
    compact: table.compact === true,
    size: (table.size === 5 ? 5 : 10) as 5 | 10,
    ranked: Array.from({ length: 10 }, (_, index) => valid.has(table.ranked?.[index] || '') ? table.ranked[index] : null),
    honorable: Array.isArray(table.honorable) ? table.honorable.filter((id): id is string => valid.has(id)) : [],
    staged: Array.isArray(table.staged) ? table.staged.filter((id): id is string => valid.has(id)) : [],
  }))
  return next.length ? next : null
}

function uniqueInTable(table: RankingTable) {
  const ids = table.ranked.filter((id): id is string => Boolean(id)).concat(table.honorable, table.staged)
  return new Set(ids)
}

function removeCard(table: RankingTable, cardId: string) {
  return {
    ...table,
    ranked: table.ranked.map((id) => id === cardId ? null : id),
    honorable: table.honorable.filter((id) => id !== cardId),
    staged: table.staged.filter((id) => id !== cardId),
  }
}

type DropTarget = {
  tableId: string
  target: 'rank' | 'honorable' | 'staged'
  index: number
}

function placeCard(tables: RankingTable[], cardId: string, destinationId: string, target: 'rank' | 'honorable' | 'staged', index: number, sourceId?: string | null, sourceLocation?: string, sourceIndex?: number) {
  if (sourceId === destinationId && sourceLocation === 'rank' && sourceIndex === index && target === 'rank') return tables

  const cleanedTables = sourceId && sourceId !== destinationId
    ? tables
    : tables.map((table) => table.id === (sourceId || destinationId) ? removeCard(table, cardId) : table)

  return cleanedTables.map((table) => {
    if (table.id !== destinationId) return table
    if (target === 'honorable') return { ...table, honorable: [...table.honorable, cardId] }
    if (target === 'staged') return { ...table, staged: [...table.staged, cardId] }

    // A rank drop always writes only to the selected slot. It never inserts,
    // shifts, swaps, or compacts any other rank.
    const displaced = table.ranked[index]
    const ranked = [...table.ranked]
    ranked[index] = cardId
    const staged = displaced && displaced !== cardId && !table.staged.includes(displaced)
      ? [...table.staged, displaced]
      : table.staged
    return { ...table, ranked, staged }
  })
}

function remoteCardToAppCard(card: { id: string; oracle_id?: string; name: string; mana_cost?: string; type_line?: string; oracle_text?: string; set: string; collector_number: string; layout: string; image_uris?: { normal?: string; large?: string }; card_faces?: Array<{ name: string; mana_cost?: string; type_line?: string; oracle_text?: string; image_uris?: { normal?: string; large?: string } }> }): Card {
  const mainImage = card.image_uris?.normal || card.image_uris?.large || card.card_faces?.[0]?.image_uris?.normal || card.card_faces?.[0]?.image_uris?.large || ''
  const faces = card.card_faces?.map((face) => ({
    name: face.name,
    manaCost: face.mana_cost || '',
    typeLine: face.type_line || '',
    oracleText: face.oracle_text || '',
    localImage: '',
    imageUrl: face.image_uris?.normal || face.image_uris?.large || mainImage,
    sourceImageUri: face.image_uris?.normal || face.image_uris?.large || mainImage,
  }))
  return {
    id: card.id,
    oracleId: card.oracle_id || null,
    name: card.name,
    manaCost: card.mana_cost || card.card_faces?.[0]?.mana_cost || '',
    typeLine: card.type_line || card.card_faces?.[0]?.type_line || '',
    oracleText: card.oracle_text || card.card_faces?.[0]?.oracle_text || '',
    set: card.set,
    collectorNumber: card.collector_number,
    layout: card.layout,
    localImage: '',
    imageUrl: mainImage,
    sourceImageUri: mainImage,
    faces: faces?.length ? faces : undefined,
  }
}

function cardImage(card: Card, faceIndex = 0) {
  const face = card.faces?.[faceIndex]
  const local = face?.localImage || card.localImage
  if (local) return `${BASE.replace(/\/$/, '')}${local.replace(/^\//, '/')}`
  return face?.imageUrl || card.imageUrl || face?.sourceImageUri || card.sourceImageUri || ''
}

function parseCardNames(input: string, cards: Card[]) {
  const knownNames = cards.flatMap((card) => [card.name, ...(card.faces?.map((face) => face.name) || [])]).sort((a, b) => b.length - a.length)
  const output: string[] = []
  for (const sourceLine of input.split(/\r?\n/)) {
    const line = sourceLine.replace(/^\s*(?:\d+\s*[.)]|[-*•])\s*/, '').trim().replace(/[;,]+$/, '').trim()
    if (!line) continue
    const matches = knownNames.filter((name) => line.toLowerCase().includes(name.toLowerCase()))
    if (matches.length) {
      output.push(...matches.sort((a, b) => line.toLowerCase().indexOf(a.toLowerCase()) - line.toLowerCase().indexOf(b.toLowerCase())))
    } else if (line.includes(',')) {
      output.push(...line.split(',').map((name) => name.trim()).filter(Boolean))
    } else {
      output.push(line)
    }
  }
  return [...new Set(output)]
}

function App() {
  const [cards, setCards] = useState<Card[]>([])
  const [tables, setTables] = useState<RankingTable[]>([])
  const [past, setPast] = useState<Snapshot[]>([])
  const [future, setFuture] = useState<Snapshot[]>([])
  const [selectedId, setSelectedId] = useState('friends-ranking')
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<Card[] | null>(null)
  const [searchingScryfall, setSearchingScryfall] = useState(false)
  const [searchNotice, setSearchNotice] = useState('')
  const [poolCollapsed, setPoolCollapsed] = useState(false)
  const [presentation, setPresentation] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [modalCard, setModalCard] = useState<Card | null>(null)
  const [modalFace, setModalFace] = useState(0)
  const [message, setMessage] = useState('')
  const [addForTable, setAddForTable] = useState<string | null>(null)
  const [addText, setAddText] = useState('')
  const [adding, setAdding] = useState(false)
  const [addResult, setAddResult] = useState<{ notFound: string[]; errors: string[] } | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 7 } }))

  useEffect(() => {
    fetch(`${BASE}data/reality-fracture.json`)
      .then((response) => {
        if (!response.ok) throw new Error('Card data is missing')
        return response.json()
      })
      .then((data: { cards: Card[] }) => {
        setCards(data.cards)
        let stored: unknown = null
        try { stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') } catch { stored = null }
        const restored = normalizeTables(stored, data.cards)
        setTables(restored || buildInitialTables(data.cards))
        setSelectedId(localStorage.getItem(SELECTED_KEY) || 'friends-ranking')
        try {
          const ui = JSON.parse(localStorage.getItem(UI_KEY) || '{}')
          setPoolCollapsed(ui.poolCollapsed === true)
          setPresentation(ui.presentation === true)
        } catch { /* use defaults */ }
      })
      .catch(() => setMessage('Run npm run sync:cards to load the local card pool.'))
  }, [])

  useEffect(() => {
    const query = search.trim()
    if (query.length < 2) {
      setSearchResults(null)
      setSearchingScryfall(false)
      setSearchNotice('')
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setSearchingScryfall(true)
      setSearchNotice('')
      try {
        const endpoint = import.meta.env.DEV ? `/api/cards/search?q=${encodeURIComponent(query)}` : `https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}`
        const response = await fetch(endpoint, { signal: controller.signal, headers: { Accept: 'application/json;q=0.9,*/*;q=0.8' } })
        const result = await response.json() as { cards?: Card[]; data?: Array<Parameters<typeof remoteCardToAppCard>[0]>; total?: number; total_cards?: number; error?: string }
        if (!response.ok) throw new Error(result.error || 'Scryfall search failed')
        const results = import.meta.env.DEV ? (result.cards || []) : (result.data || []).map(remoteCardToAppCard)
        setCards((current) => [...current, ...results.filter((card) => !current.some((item) => item.id === card.id))])
        setSearchResults(results)
        setSearchNotice(`${result.total || result.total_cards || results.length} Scryfall results${import.meta.env.DEV ? '' : ' · browser-only until cached locally'}`)
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          setSearchResults(null)
          setSearchNotice('Scryfall search unavailable')
        }
      } finally {
        setSearchingScryfall(false)
      }
    }, 450)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [search])

  useEffect(() => {
    if (tables.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(tables))
    localStorage.setItem(SELECTED_KEY, selectedId)
    localStorage.setItem(UI_KEY, JSON.stringify({ poolCollapsed, presentation }))
  }, [tables, selectedId, poolCollapsed, presentation])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (modalCard) setModalCard(null)
        else if (presentation) setPresentation(false)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [modalCard, presentation])

  const cardById = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards])
  const filteredCards = useMemo(() => searchResults || cards.filter((card) => card.name.toLowerCase().includes(search.toLowerCase())), [cards, search, searchResults])
  const activeCard = activeId ? cardById.get(activeId) || null : null
  const visibleTables = tables.filter((table) => table.visible)

  function commit(next: RankingTable[], label: string) {
    setPast((history) => [...history.slice(-49), { tables, label }])
    setFuture([])
    setTables(next)
    setMessage(label)
    window.setTimeout(() => setMessage(''), 1400)
  }

  function updateTable(id: string, updater: (table: RankingTable) => RankingTable, label: string) {
    commit(tables.map((table) => table.id === id ? updater(table) : table), label)
  }

  function handleDragStart(event: DragStartEvent) {
    const data = event.active.data.current as { cardId?: string } | undefined
    setActiveId(data?.cardId || String(event.active.id).split('::').pop() || null)
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null)
    const dragData = event.active.data.current as { cardId?: string; tableId?: string; location?: string; index?: number } | undefined
    const cardId = dragData?.cardId || String(event.active.id).split('::').pop() || ''
    const overId = event.over?.id ? String(event.over.id) : null
    if (!overId) return
    if (overId === 'card-pool') {
      const sourceTable = dragData?.tableId ? tables.find((table) => table.id === dragData.tableId) : undefined
      if (sourceTable) updateTable(sourceTable.id, (table) => removeCard(table, cardId), 'Returned to card pool')
      return
    }
    const overData = event.over?.data.current as DropTarget | undefined
    const [parsedTableId, parsedTarget, rawIndex] = overId.split('::')
    const tableId = overData?.tableId || parsedTableId
    const target = overData?.target || parsedTarget
    if (!tableId || !['rank', 'honorable', 'staged'].includes(target)) return
    const sourceTable = dragData?.tableId ? tables.find((table) => table.id === dragData.tableId) : undefined
    const destination = tables.find((table) => table.id === tableId)
    if (!destination) return
    const targetIndex = target === 'rank' ? (overData?.index ?? Number(rawIndex)) : 0
    const movingAcrossTables = sourceTable && sourceTable.id !== destination.id
    const next = placeCard(tables, cardId, tableId, target as 'rank' | 'honorable' | 'staged', targetIndex, movingAcrossTables ? null : sourceTable?.id, dragData?.location, dragData?.index)
    if (!movingAcrossTables && sourceTable && sourceTable.id === destination.id) {
      commit(next, 'Reordered ranking')
    } else if (movingAcrossTables) {
      commit(next, 'Copied card to another table')
    } else {
      commit(next, target === 'honorable' ? 'Added to honorable mentions' : target === 'staged' ? 'Added to Cards' : 'Added to ranking')
    }
  }

  function undo() {
    const previous = past[past.length - 1]
    if (!previous) return
    setFuture((history) => [{ tables, label: previous.label }, ...history.slice(0, 49)])
    setPast((history) => history.slice(0, -1))
    setTables(previous.tables)
    setMessage(`Undo · ${previous.label}`)
  }

  function redo() {
    const next = future[0]
    if (!next) return
    setPast((history) => [...history.slice(-49), { tables, label: next.label }])
    setFuture((history) => history.slice(1))
    setTables(next.tables)
    setMessage(`Redo · ${next.label}`)
  }

  function resetTable(id: string) {
    const preset = PRESETS.find((item) => item.id === id)
    const table = tables.find((item) => item.id === id)
    if (!preset || !table || !window.confirm(`Reset ${table.title}?`)) return
    const restored: RankingTable = { ...table, size: 10, ranked: Array.from({ length: 10 }, (_, index) => resolveName(preset.ranked[index] || '', cards)), honorable: [...preset.honorable.map((name) => resolveName(name, cards)), ...(preset.id === 'friends-ranking' ? cards.filter((card) => card.typeLine.includes('Elder Sphinx')).map((card) => card.id) : [])].filter((value): value is string => Boolean(value)).filter((value, index, values) => values.indexOf(value) === index), staged: [] }
    commit(tables.map((item) => item.id === id ? restored : item), 'Reset table')
  }

  function clearTable(id: string) {
    const table = tables.find((item) => item.id === id)
    if (!table || !window.confirm(`Clear "${table.title}"?\n\nThis will remove all cards from this table only.`)) return
    commit(tables.map((item) => item.id === id ? { ...item, ranked: Array(10).fill(null), honorable: [], staged: [] } : item), 'Cleared table')
  }

  function clearStaged(id: string) {
    const table = tables.find((item) => item.id === id)
    if (!table || !table.staged.length || !window.confirm(`Clear staged cards from "${table.title}"?`)) return
    updateTable(id, (item) => ({ ...item, staged: [] }), 'Cleared staged cards')
  }

  function setTableSize(id: string, size: 5 | 10) {
    const table = tables.find((item) => item.id === id)
    if (!table || table.size === size) return
    if (size === 5) {
      const overflow = table.ranked.slice(5).filter((value): value is string => Boolean(value))
      commit(tables.map((item) => item.id === id ? { ...item, size, ranked: [...item.ranked.slice(0, 5), ...Array(5).fill(null)], staged: [...item.staged, ...overflow.filter((value) => !item.staged.includes(value))] } : item), 'Switched to Top 5')
    } else {
      commit(tables.map((item) => item.id === id ? { ...item, size } : item), 'Switched to Top 10')
    }
  }

  async function addCardsToTable(id: string) {
    const table = tables.find((item) => item.id === id)
    if (!table) return
    const requested = parseCardNames(addText, cards)
    if (!requested.length) return
    setAdding(true)
    setAddResult(null)
    const existing = uniqueInTable(table)
    const localIds: string[] = []
    const missing: string[] = []
    const duplicates: string[] = []
    for (const name of requested) {
      const idForCard = resolveName(name, cards)
      if (!idForCard) missing.push(name)
      else if (existing.has(idForCard)) duplicates.push(name)
      else localIds.push(idForCard)
    }
    let fetchedCards: Card[] = []
    let notFound = [...missing]
    const errors: string[] = []
    if (missing.length && import.meta.env.DEV) {
      try {
        const response = await fetch('/api/cards/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names: missing }) })
        const result = await response.json() as { cards?: Card[]; notFound?: string[]; errors?: Array<{ requested: string; message: string }> }
        if (!response.ok) throw new Error(result.errors?.[0]?.message || 'Local card cache unavailable')
        fetchedCards = result.cards || []
        notFound = result.notFound || []
        errors.push(...(result.errors || []).map((item) => `${item.requested}: ${item.message}`))
        setCards((current) => [...current, ...fetchedCards.filter((card) => !current.some((item) => item.id === card.id))])
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    } else if (missing.length) {
      errors.push('Not in the committed card pool. Run the app locally with npm run dev to cache it.')
    }
    const stagedIds = [...localIds, ...fetchedCards.map((card) => card.id)].filter((cardId, index, values) => !existing.has(cardId) && values.indexOf(cardId) === index)
    if (stagedIds.length) commit(tables.map((item) => item.id === id ? { ...item, staged: [...item.staged, ...stagedIds] } : item), `Added ${stagedIds.length} card${stagedIds.length === 1 ? '' : 's'} to Cards`)
    setAdding(false)
    const failureNames = [...notFound, ...duplicates.map((name) => `Already in table: ${name}`), ...errors]
    if (stagedIds.length || !failureNames.length) {
      setAddForTable(null)
      setAddText('')
    } else {
      setAddResult({ notFound: failureNames.filter((item) => item.startsWith('Not in the committed') || !item.includes(': ')), errors: failureNames.filter((item) => item.includes(': ') || item.startsWith('Not in the committed')) })
    }
    if (failureNames.length) setMessage(`${stagedIds.length ? `Added ${stagedIds.length}. ` : ''}${failureNames.slice(0, 2).join(' · ')}`)
    window.setTimeout(() => setMessage(''), 2600)
  }

  function addTable() {
    const title = window.prompt('Name this ranking table', 'My Ranking')?.trim()
    if (!title) return
    const next: RankingTable = { id: makeId(), title, visible: true, compact: false, size: 10, ranked: Array(10).fill(null), honorable: [], staged: [] }
    commit([...tables, next], 'Added ranking table')
    setSelectedId(next.id)
  }

  function duplicateTable(id: string) {
    const source = tables.find((table) => table.id === id)
    if (!source) return
    const duplicate = { ...source, id: makeId(), title: `${source.title} copy`, ranked: [...source.ranked], honorable: [...source.honorable], staged: [...source.staged] }
    commit([...tables, duplicate], 'Duplicated ranking table')
  }

  function deleteTable(id: string) {
    const table = tables.find((item) => item.id === id)
    if (!table || tables.length <= 1 || !window.confirm(`Delete ${table.title}?`)) return
    const next = tables.filter((item) => item.id !== id)
    commit(next, 'Deleted ranking table')
    if (selectedId === id) setSelectedId(next[0].id)
  }

  function moveTable(id: string, direction: -1 | 1) {
    const index = tables.findIndex((table) => table.id === id)
    const newIndex = index + direction
    if (index < 0 || newIndex < 0 || newIndex >= tables.length) return
    const next = [...tables]
    const [item] = next.splice(index, 1)
    next.splice(newIndex, 0, item)
    commit(next, 'Reordered tables')
  }

  function moveCard(cardId: string, destinationId: string, target: 'rank' | 'honorable' | 'staged' | 'pool', index = 0) {
    const source = tables.find((table) => table.id === destinationId && uniqueInTable(table).has(cardId)) || tables.find((table) => uniqueInTable(table).has(cardId))
    if (target === 'pool') {
      if (source) updateTable(source.id, (table) => removeCard(table, cardId), 'Returned to card pool')
      return
    }
    const destination = tables.find((table) => table.id === destinationId)
    if (!destination) return
    const sourceRank = source ? source.ranked.indexOf(cardId) : -1
    const next = placeCard(tables, cardId, destinationId, target, index, source?.id, sourceRank >= 0 ? 'rank' : undefined, sourceRank >= 0 ? sourceRank : undefined)
    commit(next, 'Moved card')
  }

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className={`app-shell ${presentation ? 'is-presentation' : ''}`}>
        <header className="masthead">
          <div className="title-lockup">
            <div className="eyebrow">Collect &amp; Conquer Top 10 List</div>
            <h1>Reality Fracture</h1>
          </div>
          {!presentation && <div className="top-actions">
            <button className="button button-gold" onClick={addTable}>+ Add Ranking</button>
            <button className="button" onClick={() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(tables)); setMessage('Saved') }}>Save</button>
            <button className="button" onClick={undo} disabled={!past.length}>Undo</button>
            <button className="button" onClick={redo} disabled={!future.length}>Redo</button>
            <button className="button button-record" onClick={() => setPresentation(true)}>Presentation</button>
          </div>}
          {presentation && <button className="button button-exit" onClick={() => setPresentation(false)}>Exit presentation</button>}
        </header>

        <main>
          {message && <div className="toast" role="status">{message}</div>}
          {!cards.length && <div className="loading-state">{message || 'Loading card pool…'}</div>}
          {cards.length > 0 && <>
            <section className={`tables-stage count-${visibleTables.length}`} aria-label="Ranking tables">
              {tables.map((table, index) => table.visible ? <RankingTableView
                key={table.id}
                table={table}
                index={index}
                cards={cardById}
                presentation={presentation}
                selected={selectedId === table.id}
                onSelect={() => setSelectedId(table.id)}
                onRename={(title) => updateTable(table.id, (item) => ({ ...item, title }), 'Renamed table')}
                onToggleVisibility={() => updateTable(table.id, (item) => ({ ...item, visible: !item.visible }), table.visible ? 'Table hidden' : 'Table visible')}
                onToggleCompact={() => updateTable(table.id, (item) => ({ ...item, compact: !item.compact }), table.compact ? 'Normal view' : 'Compact view')}
                onSizeChange={(size) => setTableSize(table.id, size)}
                onDuplicate={() => duplicateTable(table.id)}
                onDelete={() => deleteTable(table.id)}
                onReset={() => resetTable(table.id)}
                onClearTable={() => clearTable(table.id)}
                onAddCards={() => { setAddForTable(table.id); setAddText(''); setAddResult(null) }}
                onClearCards={() => clearStaged(table.id)}
                onMoveTable={moveTable}
                onOpenCard={(card) => { setModalCard(card); setModalFace(0) }}
                onMoveCard={moveCard}
              /> : null)}
              {!presentation && tables.some((table) => !table.visible) && <button className="hidden-table-toggle" onClick={() => {
                const hidden = tables.find((table) => !table.visible)
                if (hidden) updateTable(hidden.id, (item) => ({ ...item, visible: true }), 'Table visible')
              }}>{tables.some((table) => !table.visible) ? `Show ${tables.filter((table) => !table.visible).length} hidden` : ''}</button>}
            </section>

            <section className="honorable-strip" aria-label="Honorable mentions overview">
              <div className="section-heading"><h2>Honorable Mentions</h2><span>{visibleTables.length} {visibleTables.length === 1 ? 'table' : 'tables'}</span></div>
              <div className="honorable-overview">
                {visibleTables.flatMap((table) => table.honorable.map((id) => ({ id, table }))).slice(0, 24).map(({ id, table }) => {
                  const card = cardById.get(id)
                  return card ? <button key={`${table.id}-${id}`} className="hm-overview-card" onClick={() => { setModalCard(card); setModalFace(0) }} title={`${card.name} · ${table.title}`}><img src={cardImage(card)} alt="" /><span>{card.name}</span></button> : null
                })}
                {!visibleTables.some((table) => table.honorable.length) && <span className="empty-note">Drop cards here while ranking.</span>}
              </div>
            </section>

            {!presentation && <section className={`pool-section ${poolCollapsed ? 'is-collapsed' : ''}`}>
              <div className="pool-heading">
                <button className="pool-toggle" onClick={() => setPoolCollapsed((value) => !value)} aria-expanded={!poolCollapsed}><span className="section-kicker">Card Pool</span><span className="pool-count">{cards.length} cards</span><span className="chevron">{poolCollapsed ? '＋' : '−'}</span></button>
                {!poolCollapsed && <div className="search-area"><label className="search-box"><span>Search cards</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search Scryfall card names" /></label>{(searchingScryfall || searchNotice) && <span className="search-status">{searchingScryfall ? 'Searching Scryfall…' : searchNotice}</span>}</div>}
              </div>
              {!poolCollapsed && <DroppablePool cards={filteredCards} onOpenCard={(card) => { setModalCard(card); setModalFace(0) }} />}
            </section>}
          </>}
        </main>
        {modalCard && <CardModal card={modalCard} faceIndex={modalFace} onFaceChange={setModalFace} onClose={() => setModalCard(null)} />}
        {addForTable && <AddCardsModal tableTitle={tables.find((table) => table.id === addForTable)?.title || 'Ranking'} value={addText} loading={adding} result={addResult} onChange={setAddText} onClose={() => { if (!adding) { setAddForTable(null); setAddResult(null) } }} onSubmit={() => addCardsToTable(addForTable)} />}
      </div>
      <DragOverlay dropAnimation={null}>{activeCard ? <DragCard card={activeCard} overlay /> : null}</DragOverlay>
    </DndContext>
  )
}

function RankingTableView({ table, index, cards, presentation, selected, onSelect, onRename, onToggleVisibility, onToggleCompact, onSizeChange, onDuplicate, onDelete, onReset, onClearTable, onAddCards, onClearCards, onMoveTable, onOpenCard, onMoveCard }: {
  table: RankingTable
  index: number
  cards: Map<string, Card>
  presentation: boolean
  selected: boolean
  onSelect: () => void
  onRename: (title: string) => void
  onToggleVisibility: () => void
  onToggleCompact: () => void
  onSizeChange: (size: 5 | 10) => void
  onDuplicate: () => void
  onDelete: () => void
  onReset: () => void
  onClearTable: () => void
  onAddCards: () => void
  onClearCards: () => void
  onMoveTable: (id: string, direction: -1 | 1) => void
  onOpenCard: (card: Card) => void
  onMoveCard: (cardId: string, tableId: string, target: 'rank' | 'honorable' | 'staged' | 'pool', index?: number) => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(table.title)
  const rankedCount = table.ranked.slice(0, table.size).filter(Boolean).length

  return <article className={`ranking-table ${table.visible ? '' : 'is-hidden'} ${table.compact ? 'is-compact' : ''} ${selected ? 'is-selected' : ''}`} onClick={onSelect}>
    <header className="table-header">
      <div className="table-title-wrap">
        {renaming && !presentation ? <form onSubmit={(event) => { event.preventDefault(); onRename(title.trim() || table.title); setRenaming(false) }}><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} onBlur={() => { onRename(title.trim() || table.title); setRenaming(false) }} /></form> : <h2>{table.title}</h2>}
        <span className="rank-count">{rankedCount}/10</span>
      </div>
      {!presentation && <div className="table-actions" onClick={(event) => event.stopPropagation()}>
        <label className="visibility-toggle" title="Show table"><input type="checkbox" checked={table.visible} onChange={onToggleVisibility} /><span></span></label>
        <button className="icon-button" onClick={() => onMoveTable(table.id, -1)} disabled={index === 0} aria-label="Move table left">←</button>
        <button className="icon-button" onClick={() => onMoveTable(table.id, 1)} aria-label="Move table right">→</button>
        <button className="icon-button" onClick={() => setRenaming(true)} aria-label="Rename table">✎</button>
        <button className="icon-button" onClick={onDuplicate} aria-label="Duplicate table">＋</button>
        <button className="icon-button" onClick={onReset} aria-label="Reset table">↺</button>
        <button className="icon-button danger" onClick={onDelete} aria-label="Delete table">×</button>
        <div className="size-toggle" aria-label="Ranking size">
          <span>Top</span>
          <button className={table.size === 5 ? 'is-active' : ''} onClick={() => onSizeChange(5)}>5</button>
          <button className={table.size === 10 ? 'is-active' : ''} onClick={() => onSizeChange(10)}>10</button>
        </div>
        <button className="compact-toggle" onClick={onToggleCompact}>{table.compact ? 'Normal' : 'Compact'}</button>
        <button className="compact-toggle add-cards-button" onClick={onAddCards}>ADD CARDS</button>
        <button className="compact-toggle clear-table-button" onClick={onClearTable}>Clear Table</button>
      </div>}
    </header>
    {table.visible && <div className="table-body">
      <div className="ranking-slots">
        {table.ranked.slice(0, table.size).map((id, rank) => <RankSlot key={`${table.id}-${rank}`} tableId={table.id} rank={rank} card={id ? cards.get(id) : undefined} compact={table.compact} presentation={presentation} onOpenCard={onOpenCard} onMoveCard={onMoveCard} />)}
      </div>
      <DropZone id={`${table.id}::honorable`} data={{ tableId: table.id, target: 'honorable', index: 0 }} className="table-honorable">
        <div className="subheading"><span>Honorable Mentions</span><span>{table.honorable.length}</span></div>
        <div className="honorable-cards">{table.honorable.map((id) => {
          const card = cards.get(id)
          return card ? <DraggableCard key={id} card={card} tableId={table.id} location="honorable" compact={table.compact} presentation={presentation} onOpenCard={onOpenCard} onMoveCard={onMoveCard} /> : null
        })}</div>
        {!table.honorable.length && <span className="drop-note">Drop a card here</span>}
      </DropZone>
      {(table.staged.length > 0 || !presentation) && <StagingTray tableId={table.id} cards={cards} staged={table.staged} presentation={presentation} onOpenCard={onOpenCard} onMoveCard={onMoveCard} onClearCards={onClearCards} />}
    </div>}
  </article>
}

function StagingTray({ tableId, cards, staged, presentation, onOpenCard, onMoveCard, onClearCards }: { tableId: string; cards: Map<string, Card>; staged: string[]; presentation: boolean; onOpenCard: (card: Card) => void; onMoveCard: (cardId: string, tableId: string, target: 'rank' | 'honorable' | 'staged' | 'pool', index?: number) => void; onClearCards: () => void }) {
  return <DropZone id={`${tableId}::staged`} data={{ tableId, target: 'staged', index: 0 }} className="staging-tray">
    <div className="subheading"><span>Cards</span><span>{staged.length}</span>{!presentation && staged.length > 0 && <button className="tray-clear" onClick={onClearCards}>Clear Cards</button>}</div>
    {staged.length ? <div className="staged-cards">{staged.map((id) => {
      const card = cards.get(id)
      return card ? <DraggableCard key={id} card={card} tableId={tableId} location="staged" compact={false} presentation={presentation} onOpenCard={onOpenCard} onMoveCard={onMoveCard} /> : null
    })}</div> : <span className="drop-note">Use ADD CARDS to prepare this table.</span>}
  </DropZone>
}

function RankSlot({ tableId, rank, card, compact, presentation, onOpenCard, onMoveCard }: { tableId: string; rank: number; card?: Card; compact: boolean; presentation: boolean; onOpenCard: (card: Card) => void; onMoveCard: (cardId: string, tableId: string, target: 'rank' | 'honorable' | 'staged' | 'pool', index?: number) => void }) {
  return <DropZone id={`${tableId}::rank::${rank}`} data={{ tableId, target: 'rank', index: rank }} className={`rank-slot ${card ? 'is-filled' : 'is-empty'}`}>
    <div className="rank-number">{String(rank + 1).padStart(2, '0')}</div>
    {card ? <DraggableCard card={card} tableId={tableId} location="rank" index={rank} compact={compact} presentation={presentation} onOpenCard={onOpenCard} onMoveCard={onMoveCard} /> : <span className="slot-placeholder">Drop card</span>}
  </DropZone>
}

function DropZone({ id, data, className, children }: { id: string; data?: DropTarget; className: string; children: React.ReactNode }) {
  const { isOver, setNodeRef } = useDroppable({ id, data })
  return <div ref={setNodeRef} className={`${className} ${isOver ? 'is-over' : ''}`}>{children}</div>
}

function DraggableCard({ card, tableId, location, index, compact, presentation, onOpenCard, onMoveCard }: { card: Card; tableId: string; location: 'rank' | 'honorable' | 'staged'; index?: number; compact: boolean; presentation: boolean; onOpenCard: (card: Card) => void; onMoveCard: (cardId: string, tableId: string, target: 'rank' | 'honorable' | 'staged' | 'pool', index?: number) => void }) {
  const dragId = `${tableId || 'pool'}::card::${card.id}`
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: dragId, data: { cardId: card.id, tableId, location, index } })
  const style = { transform: CSS.Translate.toString(transform) }
  return <div ref={setNodeRef} style={style} className={`draggable-card ${isDragging ? 'is-dragging' : ''}`} {...listeners} {...attributes}>
    <button className="card-face-button" onClick={(event) => { event.stopPropagation(); onOpenCard(card) }}>
      <img src={cardImage(card)} alt={`${card.name} card`} draggable={false} />
      <span className="card-name">{card.name}</span>
    </button>
    {!presentation && <div className="card-move-controls" onPointerDown={(event) => event.stopPropagation()}>
      <select value="" onChange={(event) => { const value = event.target.value; if (value === 'hm') onMoveCard(card.id, tableId, 'honorable'); else if (value === 'staged') onMoveCard(card.id, tableId, 'staged'); else if (value === 'pool') onMoveCard(card.id, tableId, 'pool'); else if (value) onMoveCard(card.id, tableId, 'rank', Number(value)); event.currentTarget.value = '' }} aria-label={`Move ${card.name}`}>
        <option value="">Move</option>
        {Array.from({ length: 10 }, (_, rank) => <option key={rank} value={rank}>#{rank + 1}</option>)}
        <option value="hm">Honorable</option>
        <option value="staged">Cards</option>
        <option value="pool">Pool</option>
      </select>
    </div>}
  </div>
}

function DragCard({ card, overlay = false }: { card: Card; overlay?: boolean }) {
  return <div className={`drag-overlay-card ${overlay ? 'is-overlay' : ''}`}><img src={cardImage(card)} alt="" /><span>{card.name}</span></div>
}

function DroppablePool({ cards, onOpenCard }: { cards: Card[]; onOpenCard: (card: Card) => void }) {
  const { isOver, setNodeRef } = useDroppable({ id: 'card-pool' })
  return <div ref={setNodeRef} className={`pool-grid ${isOver ? 'is-over' : ''}`}>
    {cards.map((card) => <div className="pool-card" key={card.id}>
      <DraggableCard card={card} tableId="" location="rank" compact presentation onOpenCard={onOpenCard} onMoveCard={() => undefined} />
    </div>)}
    {!cards.length && <span className="empty-note">No matching cards.</span>}
  </div>
}

function CardModal({ card, faceIndex, onFaceChange, onClose }: { card: Card; faceIndex: number; onFaceChange: (index: number) => void; onClose: () => void }) {
  const face = card.faces?.[faceIndex]
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="card-modal" role="dialog" aria-modal="true" aria-label={card.name}>
      <button className="modal-close" onClick={onClose} aria-label="Close card view">×</button>
      <div className="modal-art"><img src={cardImage(card, faceIndex)} alt={card.name} /></div>
      <div className="modal-copy">
        <p className="modal-kicker">{card.set.toUpperCase()} · {card.collectorNumber}</p>
        <h2>{face?.name || card.name}</h2>
        <p className="modal-mana">{face?.manaCost || card.manaCost || '—'}</p>
        <p className="modal-type">{face?.typeLine || card.typeLine}</p>
        <p className="modal-oracle">{face?.oracleText || card.oracleText || 'No Oracle text.'}</p>
        {card.faces && card.faces.length > 1 && <div className="face-switcher">{card.faces.map((item, index) => <button key={item.name} className={index === faceIndex ? 'is-active' : ''} onClick={() => onFaceChange(index)}>{index === 0 ? 'Front' : 'Back'}</button>)}</div>}
      </div>
    </section>
  </div>
}

function AddCardsModal({ tableTitle, value, loading, result, onChange, onClose, onSubmit }: { tableTitle: string; value: string; loading: boolean; result: { notFound: string[]; errors: string[] } | null; onChange: (value: string) => void; onClose: () => void; onSubmit: () => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !loading) onClose() }}>
    <section className="add-modal" role="dialog" aria-modal="true" aria-label="Add Cards">
      <button className="modal-close" onClick={onClose} disabled={loading} aria-label="Close add cards">×</button>
      <p className="modal-kicker">{tableTitle}</p>
      <h2>Add Cards</h2>
      <p className="add-modal-hint">Paste card names, one per line.</p>
      <textarea autoFocus value={value} onChange={(event) => onChange(event.target.value)} placeholder={'Samut, Tyrant of Naktamun\nKarn, Argent Defender\nStingcaster Mage'} disabled={loading} />
      {loading && <p className="add-modal-status">Finding cards and caching new artwork…</p>}
      {result && <div className="add-modal-errors">{result.notFound.map((item) => <p key={item}>Not found: “{item}”</p>)}{result.errors.map((item) => <p key={item}>{item}</p>)}</div>}
      <div className="add-modal-actions"><button className="button" onClick={onClose} disabled={loading}>Cancel</button><button className="button button-gold" onClick={onSubmit} disabled={loading || !value.trim()}>{loading ? 'Adding…' : 'Add Cards'}</button></div>
    </section>
  </div>
}

export default App
