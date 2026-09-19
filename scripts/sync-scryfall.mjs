import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()
const DATA_DIR = path.join(ROOT, 'public', 'data')
const IMAGE_DIR = path.join(ROOT, 'public', 'cards', 'reality-fracture')
const OUTPUT = path.join(DATA_DIR, 'reality-fracture.json')
const FORCE = process.argv.includes('--force')
const USER_AGENT = 'Collect-and-Conquer-Reality-Fracture/1.0 (local card sync)'
const SET_CODES = ['fra', 'frc']
const REQUEST_DELAY_MS = 140

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function safeFilename(value) {
  return value
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
}

function canonicalSort(a, b) {
  const score = (card) => {
    let value = card.set === 'fra' ? 0 : 10
    if (card.promo) value += 4
    if (card.digital) value += 8
    if (card.variation) value += 4
    if (card.border_color === 'borderless') value += 2
    if (card.frame_effects?.length) value += 1
    return value
  }
  return score(a) - score(b) || Number.parseInt(a.collector_number, 10) - Number.parseInt(b.collector_number, 10)
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json;q=0.9,*/*;q=0.8',
    },
  })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`)
  return response.json()
}

async function fetchSet(code) {
  const cards = []
  let url = `https://api.scryfall.com/cards/search?q=set%3A${encodeURIComponent(code)}`
  while (url) {
    const page = await fetchJson(url)
    cards.push(...page.data)
    url = page.has_more ? page.next_page : null
    if (url) await sleep(REQUEST_DELAY_MS)
  }
  return cards
}

function chooseCanonical(cards) {
  const byIdentity = new Map()
  for (const card of cards.sort(canonicalSort)) {
    const identity = card.oracle_id || `${card.name.toLowerCase()}|${card.layout}|${card.mana_cost || ''}|${card.oracle_text || ''}`
    if (!byIdentity.has(identity)) byIdentity.set(identity, card)
  }
  return [...byIdentity.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function imageUriFor(card, faceIndex = null) {
  if (faceIndex !== null) return card.card_faces?.[faceIndex]?.image_uris?.normal || card.card_faces?.[faceIndex]?.image_uris?.large
  return card.image_uris?.normal || card.image_uris?.large || card.card_faces?.[0]?.image_uris?.normal || card.card_faces?.[0]?.image_uris?.large
}

async function readPrevious() {
  try {
    return JSON.parse(await fs.readFile(OUTPUT, 'utf8'))
  } catch {
    return { cards: [] }
  }
}

async function downloadImage(uri, filename, previousUri) {
  const target = path.join(IMAGE_DIR, filename)
  try {
    if (!FORCE && previousUri === uri) {
      await fs.access(target)
      return 'reused'
    }
  } catch {
    // The cache entry is stale or missing; download below.
  }
  const response = await fetch(uri, { headers: { 'User-Agent': USER_AGENT, Accept: 'image/*' } })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${uri}`)
  await fs.writeFile(target, Buffer.from(await response.arrayBuffer()))
  await sleep(REQUEST_DELAY_MS)
  return 'downloaded'
}

function normalizeCard(card) {
  const stem = `${safeFilename(card.name)}-${card.id.slice(0, 8)}`
  const uri = imageUriFor(card)
  const faces = card.card_faces?.map((face, index) => {
    const faceUri = imageUriFor(card, index)
    const filename = faceUri ? `${stem}-face-${index + 1}.jpg` : `${stem}.jpg`
    return {
      name: face.name,
      manaCost: face.mana_cost || '',
      typeLine: face.type_line || '',
      oracleText: face.oracle_text || '',
      localImage: `/cards/reality-fracture/${filename}`,
      sourceImageUri: faceUri || uri,
    }
  })
  const filename = `${stem}.jpg`
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
    localImage: `/cards/reality-fracture/${filename}`,
    sourceImageUri: uri,
    faces: faces?.length ? faces : undefined,
  }
}

await fs.mkdir(DATA_DIR, { recursive: true })
await fs.mkdir(IMAGE_DIR, { recursive: true })

const rawCards = []
for (const code of SET_CODES) {
  process.stdout.write(`Fetching ${code}…\n`)
  rawCards.push(...await fetchSet(code))
  await sleep(REQUEST_DELAY_MS)
}

const canonical = chooseCanonical(rawCards)
const previous = await readPrevious()
const previousById = new Map((previous.cards || []).map((card) => [card.id, card]))
const normalized = canonical.map(normalizeCard)
const syncedIds = new Set(normalized.map((card) => card.id))
const cachedExtras = (previous.cards || []).filter((card) => !SET_CODES.includes(card.set) && !syncedIds.has(card.id))
const allCards = [...normalized, ...cachedExtras]
let downloaded = 0
let reused = 0
let failed = 0
const failures = []

for (const card of allCards) {
  const previousCard = previousById.get(card.id)
  const targets = card.faces?.length
    ? card.faces.map((face) => ({ uri: face.sourceImageUri, filename: path.basename(face.localImage) }))
    : [{ uri: card.sourceImageUri, filename: path.basename(card.localImage) }]
  for (const target of [...new Map(targets.map((item) => [item.filename, item])).values()]) {
    try {
      const previousFace = previousCard?.faces?.find((face) => face.localImage.endsWith(target.filename))
      const result = await downloadImage(target.uri, target.filename, previousFace?.sourceImageUri || previousCard?.sourceImageUri)
      if (result === 'downloaded') downloaded += 1
      else reused += 1
    } catch (error) {
      failed += 1
      failures.push(`${card.name}: ${error.message}`)
    }
  }
}

await fs.writeFile(OUTPUT, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  sourceSets: SET_CODES,
  cards: allCards,
}, null, 2)}\n`)

console.log(`Cards found: ${allCards.length}`)
console.log(`New images downloaded: ${downloaded}`)
console.log(`Images reused: ${reused}`)
console.log(`Failures: ${failed}`)
if (failures.length) console.log(failures.slice(0, 20).join('\n'))
