import fs from 'node:fs/promises'
import path from 'node:path'

const ROOT = process.cwd()
const DATA_FILE = path.join(ROOT, 'public', 'data', 'reality-fracture.json')
const IMAGE_DIR = path.join(ROOT, 'public', 'cards', 'reality-fracture')
const USER_AGENT = 'Collect-and-Conquer-Reality-Fracture/1.0 (local card cache)'
const REQUEST_DELAY_MS = 140

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function safeFilename(value) {
  return value.normalize('NFKD').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()
}

function canonicalScore(card) {
  let value = card.set === 'fra' ? 0 : card.set === 'frc' ? 1 : 10
  if (card.promo) value += 4
  if (card.digital) value += 8
  if (card.variation) value += 4
  if (card.border_color === 'borderless') value += 2
  if (card.frame_effects?.length) value += 1
  return value
}

function imageUriFor(card, faceIndex = null) {
  if (faceIndex !== null) return card.card_faces?.[faceIndex]?.image_uris?.normal || card.card_faces?.[faceIndex]?.image_uris?.large
  return card.image_uris?.normal || card.image_uris?.large || card.card_faces?.[0]?.image_uris?.normal || card.card_faces?.[0]?.image_uris?.large
}

function looseName(value) {
  return value.toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ').trim()
}

export function findLocalCard(cards, name) {
  const target = looseName(name)
  return cards.find((card) => card.name === name)
    || cards.find((card) => looseName(card.name) === target)
    || cards.find((card) => looseName(card.name.split(' // ')[0]) === target)
}

async function readDatabase() {
  try {
    return JSON.parse(await fs.readFile(DATA_FILE, 'utf8'))
  } catch {
    return { generatedAt: new Date().toISOString(), sourceSets: ['fra', 'frc'], cards: [] }
  }
}

async function fetchJson(url, accept = 'application/json;q=0.9,*/*;q=0.8') {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: accept } })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return response.json()
}

async function searchRemote(name) {
  const exactQuery = `!"${name.replaceAll('"', '\\"')}"`
  try {
    const page = await fetchJson(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(exactQuery)}`)
    if (page.data?.length) return page.data.sort((a, b) => canonicalScore(a) - canonicalScore(b))[0]
  } catch {
    // Use fuzzy lookup below for front-face names and small typos.
  }
  try {
    return await fetchJson(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`)
  } catch {
    return null
  }
}

function normalizeRemoteCard(card) {
  const stem = `${safeFilename(card.name)}-${card.id.slice(0, 8)}`
  const uri = imageUriFor(card)
  const faces = card.card_faces?.map((face, index) => {
    const faceUri = imageUriFor(card, index)
    return {
      name: face.name,
      manaCost: face.mana_cost || '',
      typeLine: face.type_line || '',
      oracleText: face.oracle_text || '',
      localImage: `/cards/reality-fracture/${faceUri ? `${stem}-face-${index + 1}.jpg` : `${stem}.jpg`}`,
      sourceImageUri: faceUri || uri,
    }
  })
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
    localImage: `/cards/reality-fracture/${stem}.jpg`,
    sourceImageUri: uri,
    faces: faces?.length ? faces : undefined,
  }
}

async function cacheImage(uri, filename) {
  if (!uri) throw new Error('Scryfall did not provide an image')
  await fs.mkdir(IMAGE_DIR, { recursive: true })
  const target = path.join(IMAGE_DIR, filename)
  try {
    await fs.access(target)
    return
  } catch {
    // Download below.
  }
  const response = await fetch(uri, { headers: { 'User-Agent': USER_AGENT, Accept: 'image/*' } })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} while downloading image`)
  await fs.writeFile(target, Buffer.from(await response.arrayBuffer()))
  await sleep(REQUEST_DELAY_MS)
}

export async function resolveAndCache(names) {
  const database = await readDatabase()
  const cards = [...database.cards]
  const resolved = []
  const alreadyPresent = []
  const fetched = []
  const notFound = []
  const errors = []

  for (const name of [...new Set(names.map((item) => item.trim()).filter(Boolean))]) {
    const local = findLocalCard(cards, name)
    if (local) {
      resolved.push(local)
      alreadyPresent.push({ requested: name, card: local })
      continue
    }
    const remote = await searchRemote(name)
    if (!remote) {
      notFound.push(name)
      continue
    }
    const existing = cards.find((card) => card.id === remote.id || (remote.oracle_id && card.oracleId === remote.oracle_id))
    if (existing) {
      resolved.push(existing)
      alreadyPresent.push({ requested: name, card: existing })
      continue
    }
    try {
      const normalized = normalizeRemoteCard(remote)
      const targets = normalized.faces?.length ? normalized.faces.map((face) => ({ uri: face.sourceImageUri, filename: path.basename(face.localImage) })) : [{ uri: normalized.sourceImageUri, filename: path.basename(normalized.localImage) }]
      for (const target of [...new Map(targets.map((item) => [item.filename, item])).values()]) await cacheImage(target.uri, target.filename)
      cards.push(normalized)
      resolved.push(normalized)
      fetched.push({ requested: name, card: normalized })
    } catch (error) {
      errors.push({ requested: name, message: error instanceof Error ? error.message : String(error) })
    }
    await sleep(REQUEST_DELAY_MS)
  }

  if (fetched.length) {
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true })
    await fs.writeFile(DATA_FILE, `${JSON.stringify({ ...database, generatedAt: new Date().toISOString(), cards }, null, 2)}\n`)
  }
  return { cards: resolved, alreadyPresent, fetched, notFound, errors }
}

export async function searchAndCache(query, limit = 40) {
  const database = await readDatabase()
  const cards = [...database.cards]
  const localMatches = cards.filter((card) => looseName(card.name).includes(looseName(query)))
  const page = await fetchJson(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}`)
  const candidates = (page.data || []).sort((a, b) => canonicalScore(a) - canonicalScore(b))
  const seen = new Set()
  const results = []
  let changed = false

  for (const remote of candidates.slice(0, limit)) {
    const existing = cards.find((card) => card.id === remote.id || (remote.oracle_id && card.oracleId === remote.oracle_id))
    if (existing) {
      if (!seen.has(existing.id)) {
        seen.add(existing.id)
        results.push(existing)
      }
      continue
    }
    const normalized = normalizeRemoteCard(remote)
    const targets = normalized.faces?.length ? normalized.faces.map((face) => ({ uri: face.sourceImageUri, filename: path.basename(face.localImage) })) : [{ uri: normalized.sourceImageUri, filename: path.basename(normalized.localImage) }]
    for (const target of [...new Map(targets.map((item) => [item.filename, item])).values()]) await cacheImage(target.uri, target.filename)
    cards.push(normalized)
    changed = true
    if (!seen.has(normalized.id)) {
      seen.add(normalized.id)
      results.push(normalized)
    }
    await sleep(REQUEST_DELAY_MS)
  }

  for (const local of localMatches) {
    if (!seen.has(local.id)) {
      seen.add(local.id)
      results.push(local)
    }
  }

  if (changed) {
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true })
    await fs.writeFile(DATA_FILE, `${JSON.stringify({ ...database, generatedAt: new Date().toISOString(), cards }, null, 2)}\n`)
  }
  return { cards: results, total: page.total_cards || results.length, fetched: changed }
}
