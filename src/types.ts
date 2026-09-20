export type CardFace = {
  name: string
  manaCost: string
  typeLine: string
  oracleText: string
  localImage: string
  imageUrl?: string
  sourceImageUri?: string
}

export type Card = {
  id: string
  oracleId: string | null
  name: string
  manaCost: string
  typeLine: string
  oracleText: string
  set: string
  collectorNumber: string
  layout: string
  localImage: string
  imageUrl?: string
  sourceImageUri?: string
  faces?: CardFace[]
}

export type RankingTable = {
  id: string
  title: string
  visible: boolean
  compact: boolean
  size: 5 | 10
  ranked: Array<string | null>
  honorable: string[]
  staged: string[]
}

export type Snapshot = {
  tables: RankingTable[]
  label: string
}
